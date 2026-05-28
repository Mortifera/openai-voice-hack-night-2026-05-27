/**
 * Codex pool — spawns and supervises real @openai/codex-sdk subprocesses.
 *
 * Replaces renderer/src/state/sim.ts's timer-driven fake agents with real
 * Codex CLI instances running in isolated git worktrees. Each spawn:
 *
 *   1. Acquires a semaphore slot (max MAX_CONCURRENT = 4 in flight).
 *   2. Creates a worktree under
 *      ~/.director/sessions/<sessionId>/agents/<agentId>/worktree/.
 *   3. Writes a per-agent AGENTS.md (Maya/Jin/Cleo/Wren persona).
 *   4. Starts a Codex thread pointed at that worktree.
 *   5. Streams JSONL events via runStreamed() back to the strip renderer
 *      via IpcChannel.CodexEvent so the state machine can drive the Hive.
 *
 * SDK shape verified against @openai/codex-sdk@0.134.0/dist/index.d.ts:
 *   - new Codex({ apiKey, env, config, baseUrl })
 *   - codex.startThread(ThreadOptions) -> Thread
 *   - thread.runStreamed(input, { signal }) -> { events: AsyncGenerator<ThreadEvent> }
 *   - ThreadEvent is a discriminated union on `type`; item events carry an
 *     `item` whose own `type` field distinguishes file_change / command_execution
 *     / agent_message / reasoning / mcp_tool_call / web_search / todo_list / error.
 */

import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
} from '@openai/codex-sdk';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannel } from '../shared/ipc.js';
import type { AgentId, AgentRole } from '../shared/state.js';
import type { CodexEvent, CodexEventType } from '../shared/codex.js';
import { createWorktree, type WorktreeHandle } from './codex-worktree.js';

// ─── Public types ──────────────────────────────────────────────────────

// `CodexEvent` + `CodexEventType` are declared in `shared/codex.ts` so the
// renderer can consume them through the preload bridge. Re-exported here
// so existing main-side callers (`code.event` IPC sender, etc.) keep
// working unchanged.
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
}

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

function buildAgentsMd(name: string, role: AgentRole, task: string): string {
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

function getCodex(): Codex {
  if (!codex) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[codex-pool] OPENAI_API_KEY missing in main process env',
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
    // Direct hand-off: keep inFlight at its current count (the released
    // slot transfers atomically to the waiter). Resolve the waiter so
    // it proceeds with the reserved slot.
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
}

const agents = new Map<AgentId, AgentRecord>();

// ─── Event emission ───────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;

export function setMainWindow(w: BrowserWindow | null): void {
  mainWindow = w;
}

function emit(event: CodexEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send(IpcChannel.CodexEvent, event);
    } catch (err) {
      console.warn('[codex-pool] emit failed', err);
    }
  }
}

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

function emitFromThreadEvent(agent_id: AgentId, ev: ThreadEvent): void {
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
      // No-op — agent_started already announced the run.
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
          phase: ev.type, // 'item.started' | 'item.updated' | 'item.completed'
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
      // Future-proofing: forward any unknown event as a generic message.
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

export type DispatchAck =
  | { ok: true; agentId: AgentId; worktree: string; branch: string }
  | { ok: false; error: string };

export async function dispatchAgent(
  req: DispatchAgentRequest,
  sessionId: string,
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

    const record: AgentRecord = {
      handle,
      thread,
      abort,
      finished: false,
    };
    agents.set(req.agentId, record);

    emit({
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

    // Fire-and-forget the streaming loop. The dispatch IPC ack returns
    // immediately with the worktree info; events flow async via codex.event.
    void (async () => {
      try {
        const { events } = await thread.runStreamed(req.task, {
          signal: abort.signal,
        });
        for await (const ev of events) {
          if (abort.signal.aborted) break;
          emitFromThreadEvent(req.agentId, ev);
        }
      } catch (err) {
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || abort.signal.aborted);
        if (!isAbort) {
          emit({
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
        emit({
          agent_id: req.agentId,
          type: 'agent_finished',
          payload: { aborted: abort.signal.aborted },
          at: Date.now(),
        });
        try {
          await record.handle.cleanup();
        } catch (err) {
          console.warn('[codex-pool] worktree cleanup failed', err);
        }
        agents.delete(req.agentId);
        release();
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
      await handle.cleanup().catch(() => {
        /* best effort */
      });
    }
    if (acquired) release();
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

export async function abortAgent(agentId: AgentId): Promise<{ ok: boolean }> {
  const rec = agents.get(agentId);
  if (!rec) return { ok: false };
  rec.abort.abort();
  // The streaming loop's finally{} block will release the slot + cleanup
  // the worktree once the runStreamed iterator rejects with AbortError.
  return { ok: true };
}

export async function abortAllAgents(): Promise<void> {
  const ids = Array.from(agents.keys());
  await Promise.all(ids.map((id) => abortAgent(id)));
}

// ─── IPC registration ─────────────────────────────────────────────────

interface DispatchIpcPayload extends DispatchAgentRequest {
  sessionId: string;
}

export function registerCodexPoolIpc(w: BrowserWindow | null): void {
  setMainWindow(w);

  ipcMain.handle(
    IpcChannel.CodexDispatch,
    async (_evt, payload: DispatchIpcPayload): Promise<DispatchAck> => {
      try {
        const { sessionId, ...rest } = payload;
        return await dispatchAgent(rest, sessionId);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IpcChannel.CodexAbort,
    async (_evt, agentId: AgentId): Promise<{ ok: boolean }> => {
      return abortAgent(agentId);
    },
  );
}
