/**
 * Codex pool — Electron wrapper around `codex-pool-core.ts`.
 *
 * Adapts the core's callback-based event emission into:
 *   - `mainWindow.webContents.send(IpcChannel.CodexEvent, …)` for the
 *     renderer strip + Hive state machine.
 *   - `ipcMain.handle(IpcChannel.CodexDispatch / CodexAbort, …)` so the
 *     tool-router (renderer-side `tool.call`) can spawn agents.
 *
 * The pure orchestration (semaphore, dispatch state, persona templates,
 * SDK plumbing) lives in `codex-pool-core.ts` so headless callers (the
 * dogfood CLI script, future test harnesses) can drive the same pool
 * without booting Electron.
 *
 * Public API surface is preserved via re-exports — `tool-router.ts`,
 * `main/index.ts`, and any future importer keeps working unchanged.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannel } from '../shared/ipc.js';
import type { AgentId } from '../shared/state.js';
import type { CodexEvent } from '../shared/codex.js';
import {
  dispatchAgentCore,
  abortAgentCore,
  abortAllAgentsCore,
  type DispatchAck,
  type DispatchAgentRequest,
} from './codex-pool-core.js';
// § P6.5 fan-in consumer — see § fan-in-consumer marker at EOF.
import {
  getBatchWorktreeHandles,
  releaseBatchWorktrees,
} from './codex-pool-core.js';
import {
  mergeFanIn,
  type AttributedWorktree,
  type MergeResult,
} from './worktree-merger.js';

// ─── Re-exports for backwards compat ──────────────────────────────────

export type { CodexEvent, CodexEventType } from '../shared/codex.js';
export type {
  DispatchAck,
  DispatchAgentRequest,
} from './codex-pool-core.js';

// ─── Event sink (renderer bridge) ─────────────────────────────────────

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
  // § P6.5 fan-in consumer — when the pool synthesizes `batch_completed`,
  // run the merge fan-in. Forward to the renderer FIRST (above) so the Hive
  // UI / logging see the raw event regardless of merge outcome.
  if (event.type === 'batch_completed') {
    void onBatchCompleted(event);
  }
}

// ─── Dispatch / abort wrappers ────────────────────────────────────────

export function dispatchAgent(
  req: DispatchAgentRequest,
  sessionId: string,
): Promise<DispatchAck> {
  return dispatchAgentCore(req, sessionId, emit);
}

export async function abortAgent(
  agentId: AgentId,
): Promise<{ ok: boolean }> {
  return { ok: abortAgentCore(agentId) };
}

export async function abortAllAgents(): Promise<void> {
  await abortAllAgentsCore();
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

// ─── § fan-in-consumer (gap 12 + advisory 16) ───────────────────────────
// Append-only marker per docs/contracts.md § 13.1. This block wires the
// previously-dead `mergeFanIn` (worktree-merger.ts) into a real production
// call path: when the pool's batch tracker synthesizes `batch_completed`
// (every agent in a `req.batchId` batch reached `agent_finished`), `emit()`
// above calls `onBatchCompleted(event)`.
//
// Flow:
//   1. Pull the retained worktree handles for the batch (gap 13 deferred
//      cleanup kept them alive past `agent_finished`).
//   2. Build `AttributedWorktree[]` + call `mergeFanIn(..., {
//      autoMergeIfNonOverlapping: true, integrationBranch })`.
//   3. auto-merge   → log; `mergeFanIn` already appended the `auto_merged`
//                     decision; then `releaseBatchWorktrees` (advisory 16
//                     `git worktree remove` each merged worktree).
//      approval      → render the `code_preview` Canvas card with the
//                     per-worktree diffs; KEEP worktrees on disk (don't
//                     release) until the user resolves. (Approval-resolution
//                     UI wiring is W5/Canvas territory — see deviations.)
//      conflict      → narrate (log); leave the conflicting worktrees on
//                     disk for manual inspection; release only the
//                     non-conflicting ones is left to a future pass — we
//                     keep all on disk to be safe.

/** Integration branch the fan-in merges into. Defaults to 'main'. */
const FAN_IN_INTEGRATION_BRANCH = 'main';

/**
 * Injectable merge driver — production uses `mergeFanIn`; unit tests inject
 * a stub so the consumer's branching logic can be exercised without git.
 */
type MergeFanInFn = typeof mergeFanIn;
let mergeDriver: MergeFanInFn = mergeFanIn;

/** Test-only: swap the merge driver. Returns a restore fn. */
export function _setMergeDriverForTests(fn: MergeFanInFn): () => void {
  const prev = mergeDriver;
  mergeDriver = fn;
  return () => {
    mergeDriver = prev;
  };
}

export async function onBatchCompleted(event: CodexEvent): Promise<void> {
  const payload = event.payload as {
    batchId?: unknown;
    worktrees?: Array<{ agentId?: unknown; path?: unknown; branch?: unknown }>;
  };
  const batchId =
    typeof payload?.batchId === 'string' ? payload.batchId : null;
  if (!batchId) {
    console.warn('[codex-pool] batch_completed without batchId — skipping fan-in');
    return;
  }

  // Pull the live (deferred-cleanup) handles the pool retained.
  const { repoRoot, handles } = getBatchWorktreeHandles(batchId);
  if (handles.length === 0) {
    console.warn(
      `[codex-pool] batch ${batchId} has no retained worktrees — nothing to merge`,
    );
    return;
  }
  const worktrees: AttributedWorktree[] = handles.map((h) => ({
    agentId: h.agentId,
    handle: h.handle,
    repoRoot: repoRoot ?? '',
  }));

  let result: MergeResult;
  try {
    result = await mergeDriver(worktrees, {
      autoMergeIfNonOverlapping: true,
      integrationBranch: FAN_IN_INTEGRATION_BRANCH,
      ...(repoRoot ? { repoRoot } : {}),
    });
  } catch (err) {
    console.error('[codex-pool] mergeFanIn threw', err);
    return;
  }

  if (result.mode === 'auto-merge') {
    console.log(
      `[codex-pool] fan-in auto-merged batch ${batchId} → ${result.integrationBranch ?? FAN_IN_INTEGRATION_BRANCH}@${result.sha ?? '?'} (${result.agents.join(', ')})`,
    );
    // Advisory 16 — release (git worktree remove + branch -D) each merged
    // worktree now that its commits live on the integration branch.
    await releaseBatchWorktrees(batchId);
    return;
  }

  if (result.mode === 'approval') {
    console.log(
      `[codex-pool] fan-in needs approval for batch ${batchId} (overlap or auto-merge disabled) — rendering code_preview`,
    );
    try {
      // Lazy import to keep the headless test path (which stubs the merge
      // driver) free of the Electron Canvas dependency.
      const { renderCanvas } = await import('./canvas.js');
      renderCanvas({
        component: 'code_preview',
        props: {
          title: 'Review agent changes',
          batchId,
          diffs: (result.diffs ?? []).map((d) => ({
            agentId: d.agentId,
            files: d.files,
            patch: d.patch,
            sha: d.sha ?? null,
          })),
        },
        component_id: `fanin-approval-${batchId}`,
      });
    } catch (err) {
      console.warn('[codex-pool] code_preview render failed', err);
    }
    // KEEP worktrees on disk until the user resolves the approval card.
    return;
  }

  // conflict — narrate + leave worktrees for manual inspection.
  console.warn(
    `[codex-pool] fan-in conflict for batch ${batchId}: ${(result.conflicts ?? []).join(', ')} — worktrees left on disk for manual merge`,
  );
}
