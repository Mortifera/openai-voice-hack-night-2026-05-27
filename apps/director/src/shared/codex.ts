/**
 * Codex pool event types — shared across main (emitter in `main/codex-pool.ts`)
 * and renderer (consumer in `renderer/src/state/ipcSync.ts`).
 *
 * Lives in `shared/` because the renderer subscribes to these via the
 * preload bridge. The main-side emitter re-exports from here, so the
 * pool's call sites keep working unchanged.
 *
 * The `payload` shape varies by `type` — the pool's emission logic
 * (`main/codex-pool.ts emitFromThreadEvent`) is the source of truth for
 * what each payload carries. The renderer's mapper is defensive: every
 * arm of the switch tolerates missing/wrong-typed fields without throwing.
 */

import type { AgentId } from './state.js';

/**
 * Narrowed event vocabulary the renderer state machine consumes. The
 * `payload` field carries the underlying SDK `ThreadEvent` (or a synthetic
 * envelope for pool-emitted events) so the renderer can extract whatever
 * fields the Hive UI needs without re-importing the SDK.
 */
export type CodexEventType =
  | 'agent_started' // synthetic — pool emits before SDK first event
  | 'thread_started' // SDK thread.started — carries thread_id
  | 'agent_message' // item.completed/updated, item.type=agent_message
  | 'reasoning' // item.*, item.type=reasoning
  | 'command_execution' // item.*, item.type=command_execution
  | 'file_change' // item.*, item.type=file_change
  | 'tool_call' // item.*, item.type ∈ {mcp_tool_call, web_search, todo_list}
  | 'error' // item.type=error OR turn.failed OR error event
  | 'turn_completed' // turn.completed (carries token usage)
  | 'agent_finished'; // synthetic — pool emits on natural end / abort / error

export interface CodexEvent {
  agent_id: AgentId;
  type: CodexEventType;
  payload: Record<string, unknown>;
  /** ms epoch when the event was minted in main. */
  at: number;
}
