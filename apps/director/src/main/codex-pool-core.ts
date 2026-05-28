/**
 * Codex pool core — pure orchestration. NO Electron imports.
 *
 * Holds everything that can run in a plain Node script (the headless
 * dogfood CLI, future test harnesses, eventually a non-Electron server
 * shell). The Electron wrapper lives in `codex-pool.ts` and adapts the
 * `onEvent` callback into `mainWindow.webContents.send(...)`.
 *
 * Public surface used by the wrapper + headless callers:
 *   - dispatchAgentCore(req, sessionId, onEvent): Promise<DispatchAck>
 *   - abortAgentCore(agentId): boolean
 *   - getActiveAgentsCore(): AgentId[]
 *   - waitForAgentCore(agentId): Promise<void>  (resolves when the streaming
 *       loop emits `agent_finished` — used by the headless dogfood to await
 *       both Codex runs without polling)
 *
 * SDK shape verified against @openai/codex-sdk@0.134.0.
 */

import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
} from '@openai/codex-sdk';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AgentId, AgentRole } from '../shared/state.js';
import type { CodexEvent, CodexEventType } from '../shared/codex.js';
import { createWorktree, type WorktreeHandle } from './codex-worktree.js';

// ─── Public types ──────────────────────────────────────────────────────

export type { CodexEvent, CodexEventType };

export interface DispatchAgentRequest {
  agentId: AgentId;
  name: string;
  role: AgentRole;
  task: string;
  /** Absolute path to the target repo (e.g. examples/mixtape). */
  targetRepo: string;
  /** Optional base branch (default 'main'). */
  baseBranch?: string;
  /**
   * Optional batch identifier — when set, the dispatched agent is tracked
   * under that batch and a synthetic `batch_completed` event fires once
   * every agent in the batch has emitted `agent_finished`. See § batch-tracking
   * marker below for the implementation.
   */
  batchId?: string;
}

export type DispatchAck =
  | { ok: true; agentId: AgentId; worktree: string; branch: string }
  | { ok: false; error: string };

export type EmitFn = (event: CodexEvent) => void;

// ─── Persona / AGENTS.md templates ────────────────────────────────────

interface RoleTemplate {
  specialty: string;
  tone: string;
}

const AGENT_TEMPLATES: Record<string, RoleTemplate> = {
  frontend: {
    specialty:
      'React + Tailwind UI implementation. Composition over inheritance. No CSS-in-JS. Match project file conventions exactly.',
    tone: 'Narrate work in brief enthusiastic gerunds ("wiring the flip animation", "tuning the spring").',
  },
  backend: {
    specialty:
      'Next.js API routes, Node-idiomatic, edge-friendly handlers. Plain HTTP semantics, no frameworks beyond what is already used.',
    tone: 'Narrate work in technical-terse declaratives ("POST /api/generate routed", "mock seed shipped").',
  },
  data: {
    specialty:
      'Schemas-first, Zod for runtime validation, file-backed JSON for demo persistence, no real DBs.',
    tone: 'Narrate work in methodical statements ("Mixtape schema written", "store helpers shipped").',
  },
  design: {
    specialty:
      'Tailwind tokens, motion primitives, theme tokens, accessibility contrast. No new color additions outside the design system.',
    tone: 'Narrate work in descriptive observations ("cassette palette tuned", "matte tokens locked").',
  },
};

const FALLBACK_TEMPLATE: RoleTemplate = {
  specialty:
    'Generalist coding agent. Match project conventions; small atomic commits; ask before structural changes.',
  tone: 'Narrate work in short factual statements.',
};

export function buildAgentsMd(
  name: string,
  role: AgentRole,
  task: string,
): string {
  const key = String(role).toLowerCase();
  const template = AGENT_TEMPLATES[key] ?? FALLBACK_TEMPLATE;
  return `# AGENTS.md — ${name} (${role})

You are **${name}**, the ${role} agent on the Director team.

## Specialization
${template.specialty}

## Narration tone
${template.tone}

## Current task
${task}

## Boundaries
- Do not reference your name or persona inside code (no \`// ${name} was here\`).
- Match the existing project conventions (lint rules, file structure, naming).
- Commit atomically: one logical change per commit.
- If you genuinely need to ask a clarifying question, end your final message with a JSON object \`{ "blocker": "<short question>" }\` so the orchestrator can escalate via voice.
`;
}

// ─── Codex client (lazy singleton) ─────────────────────────────────────

let codex: Codex | null = null;

export function getCodex(): Codex {
  if (!codex) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[codex-pool-core] OPENAI_API_KEY missing in process env',
      );
    }
    codex = new Codex({ apiKey });
  }
  return codex;
}

// ─── Semaphore ────────────────────────────────────────────────────────

const MAX_CONCURRENT = 4;
let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight += 1;
    return;
  }
  // The slot is HANDED OVER synchronously in release() — the waiter does
  // not need to increment after the await. Incrementing after the await
  // would create a microtask race where two consecutive release() calls
  // could resolve two waiters before either incremented inFlight,
  // briefly putting 5+ agents in flight.
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    next();
  } else {
    inFlight = Math.max(0, inFlight - 1);
  }
}

// ─── Live agent state ─────────────────────────────────────────────────

interface AgentRecord {
  handle: WorktreeHandle;
  thread: Thread;
  abort: AbortController;
  finished: boolean;
  /** Resolves when the streaming loop's finally{} has run. */
  done: Promise<void>;
}

const agents = new Map<AgentId, AgentRecord>();

// ─── Event classification ─────────────────────────────────────────────

function classifyItem(item: ThreadItem): CodexEventType {
  switch (item.type) {
    case 'file_change':
      return 'file_change';
    case 'command_execution':
      return 'command_execution';
    case 'agent_message':
      return 'agent_message';
    case 'reasoning':
      return 'reasoning';
    case 'mcp_tool_call':
    case 'web_search':
    case 'todo_list':
      return 'tool_call';
    case 'error':
      return 'error';
    default:
      return 'agent_message';
  }
}

function emitFromThreadEvent(
  agent_id: AgentId,
  ev: ThreadEvent,
  emit: EmitFn,
): void {
  const at = Date.now();
  switch (ev.type) {
    case 'thread.started':
      emit({
        agent_id,
        type: 'thread_started',
        payload: { thread_id: ev.thread_id },
        at,
      });
      return;
    case 'turn.started':
      return;
    case 'turn.completed':
      emit({
        agent_id,
        type: 'turn_completed',
        payload: { usage: ev.usage },
        at,
      });
      return;
    case 'turn.failed':
      emit({
        agent_id,
        type: 'error',
        payload: { message: ev.error.message },
        at,
      });
      return;
    case 'item.started':
    case 'item.updated':
    case 'item.completed':
      emit({
        agent_id,
        type: classifyItem(ev.item),
        payload: {
          phase: ev.type,
          item: ev.item,
        },
        at,
      });
      return;
    case 'error':
      emit({
        agent_id,
        type: 'error',
        payload: { message: ev.message },
        at,
      });
      return;
    default: {
      emit({
        agent_id,
        type: 'agent_message',
        payload: { unknown_event: ev as unknown as Record<string, unknown> },
        at,
      });
    }
  }
}

// ─── Dispatch / abort ─────────────────────────────────────────────────

export async function dispatchAgentCore(
  req: DispatchAgentRequest,
  sessionId: string,
  onEvent: EmitFn,
): Promise<DispatchAck> {
  if (agents.has(req.agentId)) {
    return { ok: false, error: `agent ${req.agentId} already running` };
  }
  if (!req.task || typeof req.task !== 'string') {
    return { ok: false, error: 'missing task prompt' };
  }
  if (!req.targetRepo) {
    return { ok: false, error: 'missing targetRepo' };
  }

  // § batch-tracking hookup — see marker at EOF. When req.batchId is set
  // we wrap the emit callback so agent_finished triggers a batch sweep
  // that synthesizes `batch_completed` when the last agent in the batch
  // finishes. No-op if req.batchId is undefined.
  registerAgentInBatch(req.batchId, req.agentId);
  const innerEmit = onEvent;
  onEvent = (ev) =>
    wrapEmitForBatch(req.batchId, req.agentId, innerEmit, ev);

  let acquired = false;
  let handle: WorktreeHandle | null = null;
  try {
    await acquire();
    acquired = true;

    handle = await createWorktree({
      sessionId,
      agentId: req.agentId,
      targetRepo: req.targetRepo,
      baseBranch: req.baseBranch,
    });

    await fs.writeFile(
      join(handle.path, 'AGENTS.md'),
      buildAgentsMd(req.name, req.role, req.task),
      'utf8',
    );

    const abort = new AbortController();
    const thread = getCodex().startThread({
      workingDirectory: handle.path,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      skipGitRepoCheck: false,
    });

    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const record: AgentRecord = {
      handle,
      thread,
      abort,
      finished: false,
      done,
    };
    agents.set(req.agentId, record);

    onEvent({
      agent_id: req.agentId,
      type: 'agent_started',
      payload: {
        name: req.name,
        role: req.role,
        task: req.task,
        worktree: handle.path,
        branch: handle.branch,
      },
      at: Date.now(),
    });

    void (async () => {
      try {
        const { events } = await thread.runStreamed(req.task, {
          signal: abort.signal,
        });
        for await (const ev of events) {
          if (abort.signal.aborted) break;
          emitFromThreadEvent(req.agentId, ev, onEvent);
        }
      } catch (err) {
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || abort.signal.aborted);
        if (!isAbort) {
          onEvent({
            agent_id: req.agentId,
            type: 'error',
            payload: {
              message: err instanceof Error ? err.message : String(err),
            },
            at: Date.now(),
          });
        }
      } finally {
        record.finished = true;
        onEvent({
          agent_id: req.agentId,
          type: 'agent_finished',
          payload: { aborted: abort.signal.aborted },
          at: Date.now(),
        });
        try {
          await record.handle.cleanup();
        } catch (err) {
          console.warn('[codex-pool-core] worktree cleanup failed', err);
        }
        agents.delete(req.agentId);
        release();
        resolveDone();
      }
    })();

    return {
      ok: true,
      agentId: req.agentId,
      worktree: handle.path,
      branch: handle.branch,
    };
  } catch (err) {
    if (handle) {
      await handle.cleanup().catch(() => {});
    }
    if (acquired) release();
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export function abortAgentCore(agentId: AgentId): boolean {
  const rec = agents.get(agentId);
  if (!rec) return false;
  rec.abort.abort();
  return true;
}

export function getActiveAgentsCore(): AgentId[] {
  return Array.from(agents.keys());
}

/**
 * Resolves once the streaming loop has emitted `agent_finished` and
 * released its semaphore slot. Returns immediately if the agent isn't
 * (or no longer is) live in the pool.
 */
export function waitForAgentCore(agentId: AgentId): Promise<void> {
  const rec = agents.get(agentId);
  if (!rec) return Promise.resolve();
  return rec.done;
}

export async function abortAllAgentsCore(): Promise<void> {
  const ids = Array.from(agents.keys());
  const dones: Promise<void>[] = [];
  for (const id of ids) {
    const rec = agents.get(id);
    if (!rec) continue;
    rec.abort.abort();
    dones.push(rec.done);
  }
  await Promise.all(dones);
}

// ─── § batch-tracking ──────────────────────────────────────────────────
//
// Phase 6.5 fan-in support. When `dispatchAgentCore` is called with a
// `batchId`, the agent is registered under that batch via
// `registerAgentInBatch(...)`. The emit callback is wrapped by
// `wrapEmitForBatch(...)` so when each agent's synthetic
// `agent_finished` event flows through, we sweep the batch — once every
// agent in the batch is marked finished, a synthetic `batch_completed`
// event is emitted via the same `onEvent` callback with payload
// `{ batchId, worktrees: [{ agentId, path, branch }] }`. The planner's
// worktree-merger module consumes that envelope to fan-in merge.
//
// Each agent's worktree handle is captured at dispatch time (before the
// async streaming loop calls `record.handle.cleanup()` in its finally
// block — that cleanup tears down the worktree directory). The synthetic
// `batch_completed` payload therefore carries the worktree's absolute
// path + branch name at the moment of dispatch, even though the
// directory may already be in the process of being removed when the
// final agent's `agent_finished` fires. Callers (planner / worktree-
// merger) are responsible for capturing HEAD shas inline before the
// pool's cleanup races to remove the worktree. For now this matches
// the dogfood pattern of synchronously execFileSync'ing `git rev-parse`
// inside the `agent_finished` handler.

interface BatchAgentEntry {
  agentId: AgentId;
  worktreePath: string | null;
  branch: string | null;
  finished: boolean;
}

interface BatchRecord {
  batchId: string;
  agents: Map<AgentId, BatchAgentEntry>;
  emitted: boolean;
}

const batches = new Map<string, BatchRecord>();

function registerAgentInBatch(
  batchId: string | undefined,
  agentId: AgentId,
): void {
  if (!batchId) return;
  let batch = batches.get(batchId);
  if (!batch) {
    batch = { batchId, agents: new Map(), emitted: false };
    batches.set(batchId, batch);
  }
  if (!batch.agents.has(agentId)) {
    batch.agents.set(agentId, {
      agentId,
      worktreePath: null,
      branch: null,
      finished: false,
    });
  }
}

function recordBatchWorktree(
  batchId: string | undefined,
  agentId: AgentId,
  worktree: string | undefined,
  branch: string | undefined,
): void {
  if (!batchId) return;
  const batch = batches.get(batchId);
  if (!batch) return;
  const entry = batch.agents.get(agentId);
  if (!entry) return;
  if (typeof worktree === 'string') entry.worktreePath = worktree;
  if (typeof branch === 'string') entry.branch = branch;
}

function maybeEmitBatchCompleted(
  batchId: string | undefined,
  onEvent: EmitFn,
): void {
  if (!batchId) return;
  const batch = batches.get(batchId);
  if (!batch || batch.emitted) return;
  const allFinished = Array.from(batch.agents.values()).every(
    (a) => a.finished,
  );
  if (!allFinished) return;
  batch.emitted = true;
  const worktrees = Array.from(batch.agents.values()).map((a) => ({
    agentId: a.agentId,
    path: a.worktreePath,
    branch: a.branch,
  }));
  // Use the first agent in the batch as `agent_id` since CodexEvent is
  // typed per-agent. Downstream batch consumers identify by `batchId` in
  // the payload, not by `agent_id`.
  const firstAgentId = batch.agents.keys().next().value as AgentId;
  try {
    onEvent({
      agent_id: firstAgentId,
      type: 'batch_completed',
      payload: {
        batchId,
        worktrees,
      },
      at: Date.now(),
    });
  } catch (err) {
    console.warn('[codex-pool-core] batch_completed emit failed', err);
  }
  // Don't delete the batch record — keep it for diagnostics. A future
  // helper can reset() it. Memory cost is trivial (handful of entries).
}

/**
 * Emit wrapper invoked by `dispatchAgentCore` for every event the
 * streaming loop produces. Always forwards the event to the inner emit
 * callback first, then performs the batch-tracking side effects.
 */
function wrapEmitForBatch(
  batchId: string | undefined,
  agentId: AgentId,
  innerEmit: EmitFn,
  ev: CodexEvent,
): void {
  // Forward first — never let batch bookkeeping prevent the renderer
  // from seeing the underlying event.
  try {
    innerEmit(ev);
  } catch (err) {
    console.warn('[codex-pool-core] innerEmit threw', err);
  }
  if (!batchId) return;
  try {
    if (ev.type === 'agent_started') {
      const payload = ev.payload as {
        worktree?: unknown;
        branch?: unknown;
      };
      recordBatchWorktree(
        batchId,
        agentId,
        typeof payload?.worktree === 'string'
          ? payload.worktree
          : undefined,
        typeof payload?.branch === 'string' ? payload.branch : undefined,
      );
      return;
    }
    if (ev.type === 'agent_finished') {
      const batch = batches.get(batchId);
      const entry = batch?.agents.get(agentId);
      if (entry) entry.finished = true;
      maybeEmitBatchCompleted(batchId, innerEmit);
    }
  } catch (err) {
    console.warn('[codex-pool-core] batch tracking error', err);
  }
}

/**
 * Test-only / lifecycle reset. Drops every batch record. Called by the
 * Electron wrapper's shutdown path (future) and by unit tests that need
 * a clean slate between cases.
 */
export function _resetBatchTrackingForTests(): void {
  batches.clear();
}

/**
 * Test-only helper: drive the batch-tracking state machine without
 * spawning Codex. Exposes the private registration + wrap functions so
 * a unit test can verify the synthetic `batch_completed` envelope
 * shape without booting the SDK.
 */
export const _batchTrackingTestHooks = {
  register: registerAgentInBatch,
  emit: wrapEmitForBatch,
};

/**
 * Diagnostic: inspect a batch record (e.g. for tests or future tooling).
 * Returns `null` if no batch with that id is registered.
 */
export function getBatchSnapshot(batchId: string): {
  batchId: string;
  agents: Array<{
    agentId: AgentId;
    worktreePath: string | null;
    branch: string | null;
    finished: boolean;
  }>;
  emitted: boolean;
} | null {
  const batch = batches.get(batchId);
  if (!batch) return null;
  return {
    batchId,
    agents: Array.from(batch.agents.values()).map((a) => ({
      agentId: a.agentId,
      worktreePath: a.worktreePath,
      branch: a.branch,
      finished: a.finished,
    })),
    emitted: batch.emitted,
  };
}
