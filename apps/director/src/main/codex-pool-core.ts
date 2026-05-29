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
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
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
  registerAgentInBatch(req.batchId, req.agentId, req.targetRepo);
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
        // § P6.4 DIRECTOR_TEST_HANG — see EOF marker. When the env var
        // names THIS agent, deliberately stall the run loop (no SDK call,
        // no events) until the abort signal fires. This drives the hang
        // watchdog headlessly: with no output flowing, `lastOutputAt`
        // never advances past the dispatch-time `agent_started` and the
        // watchdog escalates after `DIRECTOR_HANG_THRESHOLD_MS`.
        if (shouldDeliberatelyHang(req.agentId)) {
          await waitForAbort(abort.signal);
        } else {
          const { events } = await thread.runStreamed(req.task, {
            signal: abort.signal,
          });
          for await (const ev of events) {
            if (abort.signal.aborted) break;
            emitFromThreadEvent(req.agentId, ev, onEvent);
          }
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
        // § gap 13 — defer cleanup for batched agents. If this agent
        // belongs to a batch, DO NOT tear down the worktree here: the
        // synthetic `batch_completed` consumer (worktree-merger fan-in)
        // needs the branch + worktree dir intact to compute diffs and
        // merge. We stash the live handle on the batch record and the
        // consumer calls `releaseBatchWorktrees(batchId)` post-merge.
        // Non-batched agents keep the original eager cleanup.
        const deferred = stashHandleForBatch(req.batchId, req.agentId, record.handle);
        if (!deferred) {
          try {
            await record.handle.cleanup();
          } catch (err) {
            console.warn('[codex-pool-core] worktree cleanup failed', err);
          }
        }
        onEvent({
          agent_id: req.agentId,
          type: 'agent_finished',
          payload: { aborted: abort.signal.aborted },
          at: Date.now(),
        });
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

// ─── § P6.4 kill/extend resolution (gap 14) ────────────────────────────
//
// Phase 6.4 DoD: after the watchdog escalates ("kill or extend?"), the
// user's voice answer routes to one of two resolutions (the tool-router
// exposes `kill_agent` / `extend_agent` handlers that call into here):
//
//   - KILL  → `killAgentCore(agentId)`: archive the agent's worktree to
//             `~/.director/abandoned/<ts>-<agent>/` (so the user can inspect
//             the abandoned work) THEN abort the agent. The underlying SDK
//             abort resolves the run loop; the finally{} block emits
//             `agent_finished` and git-removes the now-archived worktree.
//             SIGTERM→grace→SIGKILL of the Codex subprocess is owned by the
//             SDK behind `AbortController` — we drive it via `abort()`.
//   - EXTEND → `extendHangThreshold(agentId)` (above): re-arm + double the
//             threshold for the next escalation.

/** Archive root for killed-agent worktrees (advisory: keep, don't delete). */
function abandonedRoot(): string {
  return join(homedir(), '.director', 'abandoned');
}

export interface KillAgentResult {
  ok: boolean;
  /** Absolute path the worktree contents were archived to (if any). */
  archivedTo?: string;
  error?: string;
}

/**
 * § gap 14 — resolve a hang by killing the agent. Snapshots the agent's
 * worktree into the abandoned dir, then aborts so the run loop unwinds.
 * Safe to call for a non-live agent (returns ok:false). Archiving is
 * best-effort: an archive failure still aborts the agent (we never want a
 * stuck FS to block the kill).
 */
export async function killAgentCore(
  agentId: AgentId,
): Promise<KillAgentResult> {
  const rec = agents.get(agentId);
  if (!rec) {
    return { ok: false, error: `agent ${agentId} not running` };
  }
  let archivedTo: string | undefined;
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(abandonedRoot(), `${ts}-${agentId}`);
    await fs.mkdir(dirname(dest), { recursive: true });
    // Copy the worktree contents (the git worktree dir gets removed by the
    // finally{} cleanup; the archive is an independent snapshot).
    await fs.cp(rec.handle.path, dest, { recursive: true });
    archivedTo = dest;
  } catch (err) {
    console.warn(
      `[codex-pool-core] kill archive failed for ${agentId}`,
      err,
    );
  }
  // Clear any hang-fired flag so we don't re-escalate during teardown.
  hangState.hangFired.delete(agentId);
  rec.abort.abort();
  return { ok: true, archivedTo };
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

// ─── § P6.4 DIRECTOR_TEST_HANG ─────────────────────────────────────────
//
// Phase 6.4 DoD (`docs/remaining-phases.md` § 6.4): a headless way to make
// a named agent deliberately stall so the 60s hang watchdog + kill/extend
// escalation can be exercised without a live Codex run. When
// `DIRECTOR_TEST_HANG` equals an agent id, `dispatchAgentCore` skips the
// SDK run loop entirely and parks on the abort signal — no events flow, so
// the watchdog's `lastOutputAt` for that agent never advances past the
// dispatch-time `agent_started` and it escalates after
// `DIRECTOR_HANG_THRESHOLD_MS` (tests set a short threshold).
//
// `kill_agent` (tool-router) aborts the agent, which resolves `waitForAbort`
// and lets the finally{} block run normally (archive + agent_finished).

function shouldDeliberatelyHang(agentId: AgentId): boolean {
  const target = process.env.DIRECTOR_TEST_HANG;
  return typeof target === 'string' && target.length > 0 && target === agentId;
}

/** Resolve when the abort signal fires (never on its own). */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
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
  /**
   * § gap 13 — live worktree handle retained past `agent_finished` for
   * batched agents so the fan-in consumer can diff/merge before cleanup.
   * Null until the streaming loop's finally{} stashes it; null again
   * after `releaseBatchWorktrees` tears it down.
   */
  handle: WorktreeHandle | null;
}

interface BatchRecord {
  batchId: string;
  agents: Map<AgentId, BatchAgentEntry>;
  emitted: boolean;
  /**
   * § gap 12 — host repo the agents' worktrees were added to (the dispatch
   * `targetRepo`). The fan-in consumer needs this to point `mergeFanIn` at
   * the integration repo. All agents in a batch share one target repo.
   */
  repoRoot: string | null;
}

const batches = new Map<string, BatchRecord>();

function registerAgentInBatch(
  batchId: string | undefined,
  agentId: AgentId,
  repoRoot?: string,
): void {
  if (!batchId) return;
  let batch = batches.get(batchId);
  if (!batch) {
    batch = { batchId, agents: new Map(), emitted: false, repoRoot: null };
    batches.set(batchId, batch);
  }
  if (repoRoot && !batch.repoRoot) batch.repoRoot = repoRoot;
  if (!batch.agents.has(agentId)) {
    batch.agents.set(agentId, {
      agentId,
      worktreePath: null,
      branch: null,
      finished: false,
      handle: null,
    });
  }
}

/**
 * § gap 13 — stash a finished batched agent's live worktree handle so the
 * fan-in consumer can diff/merge against intact branches. Returns `true`
 * when the handle was retained (cleanup deferred), `false` when the agent
 * does not belong to a tracked batch (caller cleans up eagerly).
 */
function stashHandleForBatch(
  batchId: string | undefined,
  agentId: AgentId,
  handle: WorktreeHandle,
): boolean {
  if (!batchId) return false;
  const batch = batches.get(batchId);
  if (!batch) return false;
  const entry = batch.agents.get(agentId);
  if (!entry) return false;
  entry.handle = handle;
  return true;
}

/**
 * § gap 13 — tear down every retained worktree for a batch. The fan-in
 * consumer (worktree-merger) calls this AFTER `mergeFanIn` resolves so the
 * branches survive long enough to be diffed + merged. Advisory 16: callers
 * that auto-merge should `git worktree remove` first (mergeFanIn handles
 * the integration-branch side); this just disposes the per-agent handles
 * the pool deferred. Idempotent — clears each handle after cleanup so a
 * double call is a no-op. `skip` lets a conflict path keep specific agents'
 * worktrees on disk for manual inspection.
 */
export async function releaseBatchWorktrees(
  batchId: string,
  opts?: { skip?: AgentId[] },
): Promise<void> {
  const batch = batches.get(batchId);
  if (!batch) return;
  const skip = new Set(opts?.skip ?? []);
  const handles: Array<{ agentId: AgentId; handle: WorktreeHandle }> = [];
  for (const entry of batch.agents.values()) {
    if (entry.handle && !skip.has(entry.agentId)) {
      handles.push({ agentId: entry.agentId, handle: entry.handle });
    }
  }
  await Promise.all(
    handles.map(async ({ agentId, handle }) => {
      try {
        await handle.cleanup();
      } catch (err) {
        console.warn(
          `[codex-pool-core] deferred worktree cleanup failed for ${agentId}`,
          err,
        );
      }
      const entry = batch.agents.get(agentId);
      if (entry) entry.handle = null;
    }),
  );
}

/**
 * § gap 13 — expose the retained handles for a completed batch so the
 * Electron-side consumer can build `AttributedWorktree[]` for `mergeFanIn`
 * without re-deriving paths. `repoRoot` is the shared host repo captured at
 * dispatch. `handles` is `[]` if the batch is unknown or no handles were
 * stashed (e.g. a non-deferred / already-released batch).
 */
export function getBatchWorktreeHandles(batchId: string): {
  repoRoot: string | null;
  handles: Array<{ agentId: AgentId; handle: WorktreeHandle }>;
} {
  const batch = batches.get(batchId);
  if (!batch) return { repoRoot: null, handles: [] };
  const handles: Array<{ agentId: AgentId; handle: WorktreeHandle }> = [];
  for (const entry of batch.agents.values()) {
    if (entry.handle) {
      handles.push({ agentId: entry.agentId, handle: entry.handle });
    }
  }
  return { repoRoot: batch.repoRoot, handles };
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
  // § P6.4 hang-watchdog: observe every emit BEFORE forwarding so that
  // even if `innerEmit` throws we still reset the per-agent stopwatch.
  // The watchdog auto-starts lazily on first observation (see EOF marker).
  try {
    notifyEmitForHangWatchdog(agentId, innerEmit);
  } catch (err) {
    console.warn('[codex-pool-core] hang-watchdog notify threw', err);
  }
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
  /**
   * Test-only: seed a retained worktree handle onto a batch entry so the
   * Electron-side fan-in consumer (`codex-pool.ts onBatchCompleted`) can be
   * exercised without driving a real dispatch finally{}.
   */
  seedHandle: (
    batchId: string,
    agentId: AgentId,
    handle: WorktreeHandle,
    repoRoot?: string,
  ): void => {
    registerAgentInBatch(batchId, agentId, repoRoot);
    stashHandleForBatch(batchId, agentId, handle);
  },
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

// ─── § P6.4 hang-watchdog ──────────────────────────────────────────────
//
// Phase 6.4 (`docs/remaining-phases.md` § 6.4): per-agent stopwatch that
// fires a synthetic `agent_hang_suspected` event when an agent has
// produced no output for longer than `DIRECTOR_HANG_THRESHOLD_MS`
// (default 60_000ms). The synthetic event flows through the same
// `onEvent` callback the rest of the pool uses — so the renderer's
// `codex.event` handler picks it up identically. A separately registered
// `hangAnnouncer` callback is invoked on main-side as well so the tool
// router can forward to the planner's proactive announcement helper.
//
// Configuration:
//   - DIRECTOR_HANG_THRESHOLD_MS — env var (default 60_000)
//   - DIRECTOR_HANG_INTERVAL_MS  — env var (default min(thresholdMs/4, 15_000))
//
// Lifecycle:
//   - `wrapEmitForBatch` calls `notifyEmitForHangWatchdog(agentId, emit)`
//     on every observed event. The first call captures the emit
//     reference + arms a single setInterval. Idempotent — subsequent
//     calls only refresh `lastOutputAt` for the agent.
//   - When `now - lastOutputAt > thresholdMs`, the watchdog emits the
//     synthetic event AND calls the registered `hangAnnouncer`. The
//     `hangFired` flag is then set so we don't spam — it clears the next
//     time `notifyEmitForHangWatchdog` is called for that agent (next
//     real output) OR when `resetHangStopwatch(agentId)` is called
//     (planner's "more time" response).
//
// Tests inject low thresholds via `setupHangWatchdogForTests` — that
// helper bypasses env vars + allows the emit reference + clock to be
// supplied directly so a unit test never needs to drive `wrapEmitFor
// Batch`.

const HANG_THRESHOLD_DEFAULT_MS = 60_000;

interface HangWatchdogState {
  emit: EmitFn | null;
  thresholdMs: number;
  intervalMs: number;
  interval: ReturnType<typeof setInterval> | null;
  lastOutputAt: Map<AgentId, number>;
  hangFired: Set<AgentId>;
  announcer: ((agentId: AgentId) => void | Promise<void>) | null;
  now: () => number;
  /**
   * § gap 14 — per-agent threshold override. When the user says "more
   * time", `extendHangThreshold(agentId)` doubles that agent's escalation
   * threshold for the NEXT fire (default → 120s). Falls back to the global
   * `thresholdMs` when no override is set.
   */
  perAgentThresholdMs: Map<AgentId, number>;
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function defaultThresholdMs(): number {
  return readEnvNumber('DIRECTOR_HANG_THRESHOLD_MS', HANG_THRESHOLD_DEFAULT_MS);
}

function defaultIntervalMs(thresholdMs: number): number {
  // Sample at thresholdMs/4 by default, clamped to [50ms, 15_000ms] so
  // tests with a 200ms threshold still tick under the threshold but the
  // production 60s threshold doesn't churn a wakeup every 15s.
  const envOverride = readEnvNumber('DIRECTOR_HANG_INTERVAL_MS', 0);
  if (envOverride > 0) return envOverride;
  const computed = Math.max(50, Math.min(Math.floor(thresholdMs / 4), 15_000));
  return computed;
}

const hangState: HangWatchdogState = {
  emit: null,
  thresholdMs: defaultThresholdMs(),
  intervalMs: defaultIntervalMs(defaultThresholdMs()),
  interval: null,
  lastOutputAt: new Map(),
  hangFired: new Set(),
  announcer: null,
  now: () => Date.now(),
  perAgentThresholdMs: new Map(),
};

function ensureHangWatchdogStarted(): void {
  if (hangState.interval) return;
  hangState.interval = setInterval(checkHangWatchdog, hangState.intervalMs);
  // Allow Node to exit even if this interval is the only thing alive
  // (matters for tests + the headless dogfood CLI).
  if (typeof hangState.interval.unref === 'function') {
    hangState.interval.unref();
  }
}

function checkHangWatchdog(): void {
  if (!hangState.emit && !hangState.announcer) return;
  const now = hangState.now();
  for (const [agentId, lastAt] of hangState.lastOutputAt.entries()) {
    if (hangState.hangFired.has(agentId)) continue;
    const sinceMs = now - lastAt;
    // § gap 14 — honor a per-agent extended threshold if the user asked
    // for "more time"; otherwise the global threshold applies.
    const effectiveThreshold =
      hangState.perAgentThresholdMs.get(agentId) ?? hangState.thresholdMs;
    if (sinceMs <= effectiveThreshold) continue;
    hangState.hangFired.add(agentId);
    const event: CodexEvent = {
      agent_id: agentId,
      type: 'agent_hang_suspected',
      payload: {
        thresholdMs: effectiveThreshold,
        lastOutputAt: lastAt,
        sinceMs,
      },
      at: now,
    };
    if (hangState.emit) {
      try {
        hangState.emit(event);
      } catch (err) {
        console.warn('[codex-pool-core] hang-watchdog emit threw', err);
      }
    }
    if (hangState.announcer) {
      try {
        const ret = hangState.announcer(agentId);
        if (ret && typeof (ret as Promise<unknown>).catch === 'function') {
          (ret as Promise<unknown>).catch((err) =>
            console.warn(
              '[codex-pool-core] hang-watchdog announcer rejected',
              err,
            ),
          );
        }
      } catch (err) {
        console.warn(
          '[codex-pool-core] hang-watchdog announcer threw',
          err,
        );
      }
    }
  }
}

/**
 * Called from `wrapEmitForBatch` on every event the pool surfaces. Pure
 * side-effect: updates `lastOutputAt`, clears the `hangFired` flag, and
 * lazily starts the watchdog interval. Capturing the emit function from
 * the first observation means consumers don't need to wire anything up
 * — the wrapper file just calls `dispatchAgentCore(..., emit)` as it
 * always has.
 *
 * Exported so tests can drive the notification directly without going
 * through `wrapEmitForBatch`.
 */
export function notifyEmitForHangWatchdog(
  agentId: AgentId,
  emit: EmitFn,
): void {
  if (!agentId || typeof agentId !== 'string') return;
  if (!hangState.emit && typeof emit === 'function') {
    hangState.emit = emit;
  }
  hangState.lastOutputAt.set(agentId, hangState.now());
  hangState.hangFired.delete(agentId);
  ensureHangWatchdogStarted();
}

/**
 * Register the main-side hang announcer. The tool-router wires this so
 * the planner can publish the "Maya seems stuck — kill or extend?"
 * proactive announcement when the watchdog fires. Returns a teardown
 * that clears the announcer.
 */
export function setHangAnnouncer(
  fn: ((agentId: AgentId) => void | Promise<void>) | null,
): () => void {
  hangState.announcer = fn;
  return () => {
    if (hangState.announcer === fn) hangState.announcer = null;
  };
}

/**
 * Re-arm the stopwatch for a specific agent without piping a real event
 * through. Used when the user says "more time" — the planner can bump
 * the threshold (caller's responsibility) and ping notify here so the
 * watchdog doesn't immediately re-fire.
 */
export function resetHangStopwatch(agentId: AgentId): void {
  hangState.lastOutputAt.set(agentId, hangState.now());
  hangState.hangFired.delete(agentId);
}

/**
 * § gap 14 — "more time" resolution. Re-arms the stopwatch for `agentId`
 * AND doubles its escalation threshold for the next fire (default 60s →
 * 120s; a prior extension to 120s → 240s, etc). Returns the new effective
 * threshold so the caller can narrate it. The `extend_agent` tool-router
 * handler calls this when the user answers "give it more time".
 */
export function extendHangThreshold(agentId: AgentId): number {
  const current =
    hangState.perAgentThresholdMs.get(agentId) ?? hangState.thresholdMs;
  const next = current * 2;
  hangState.perAgentThresholdMs.set(agentId, next);
  // Reset the stopwatch so the watchdog doesn't immediately re-fire on the
  // already-elapsed gap.
  hangState.lastOutputAt.set(agentId, hangState.now());
  hangState.hangFired.delete(agentId);
  return next;
}

/**
 * § gap 14 — current effective hang threshold for an agent (per-agent
 * override if set, else the global default). Exposed for the kill/extend
 * tool handlers + tests.
 */
export function getEffectiveHangThreshold(agentId: AgentId): number {
  return hangState.perAgentThresholdMs.get(agentId) ?? hangState.thresholdMs;
}

/** Test-only: drop every entry + clear the interval so cases stay isolated. */
export function _resetHangWatchdogForTests(): void {
  if (hangState.interval) {
    clearInterval(hangState.interval);
    hangState.interval = null;
  }
  hangState.emit = null;
  hangState.announcer = null;
  hangState.lastOutputAt.clear();
  hangState.hangFired.clear();
  hangState.perAgentThresholdMs.clear();
  hangState.thresholdMs = defaultThresholdMs();
  hangState.intervalMs = defaultIntervalMs(hangState.thresholdMs);
  hangState.now = () => Date.now();
}

/**
 * Test/lifecycle helper: configure the watchdog with explicit thresholds
 * and (optionally) an injected emit + clock. Returns a teardown.
 *
 * Production code does NOT need to call this — `notifyEmitForHangWatchdog`
 * captures the emit reference + reads `DIRECTOR_HANG_THRESHOLD_MS` from
 * env on first observation. Tests use it to bypass env vars and inject
 * a controllable clock.
 */
export function setupHangWatchdogForTests(opts: {
  emit?: EmitFn;
  thresholdMs?: number;
  intervalMs?: number;
  now?: () => number;
  announcer?: (agentId: AgentId) => void | Promise<void>;
}): { stop: () => void } {
  _resetHangWatchdogForTests();
  if (typeof opts.thresholdMs === 'number' && opts.thresholdMs > 0) {
    hangState.thresholdMs = opts.thresholdMs;
    hangState.intervalMs = defaultIntervalMs(opts.thresholdMs);
  }
  if (typeof opts.intervalMs === 'number' && opts.intervalMs > 0) {
    hangState.intervalMs = opts.intervalMs;
  }
  if (typeof opts.now === 'function') {
    hangState.now = opts.now;
  }
  if (opts.emit) {
    hangState.emit = opts.emit;
  }
  if (opts.announcer) {
    hangState.announcer = opts.announcer;
  }
  return {
    stop: () => {
      if (hangState.interval) {
        clearInterval(hangState.interval);
        hangState.interval = null;
      }
    },
  };
}

/** Diagnostic snapshot — for tests + future tooling. */
export function getHangWatchdogSnapshot(): {
  thresholdMs: number;
  intervalMs: number;
  running: boolean;
  agents: Array<{
    agentId: AgentId;
    lastOutputAt: number;
    fired: boolean;
  }>;
} {
  return {
    thresholdMs: hangState.thresholdMs,
    intervalMs: hangState.intervalMs,
    running: hangState.interval !== null,
    agents: Array.from(hangState.lastOutputAt.entries()).map(([id, at]) => ({
      agentId: id,
      lastOutputAt: at,
      fired: hangState.hangFired.has(id),
    })),
  };
}

/**
 * Force a check tick — only for tests that want to advance the virtual
 * clock and assert behavior without waiting on `setInterval`.
 */
export function _tickHangWatchdogForTests(): void {
  checkHangWatchdog();
}
