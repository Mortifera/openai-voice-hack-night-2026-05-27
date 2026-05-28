/**
 * IPC channel surface between Electron main, preload, and renderer.
 *
 * Spec: docs/ipc-contracts.md (authoritative). This file is the single
 * source of truth for channel names and payload shapes — main + preload
 * import from here, the renderer imports through the preload's
 * `window.director` bridge.
 *
 * Conventions:
 *   - Channel keys are `<domain>.<action>`. Wire strings are stable —
 *     never rename without bumping `app.ready.protocolVersion`. The four
 *     legacy `director:*` channels predate the convention and keep their
 *     original wire strings so the W1 scaffolding (main/index.ts, preload)
 *     keeps working unchanged.
 *   - `invoke` responses always shape `{ ok: true; ... } | { ok: false; error }`.
 *   - Fire-and-forget events use `send` / `on` — no return type.
 *   - All payloads are structured-clone-safe: plain objects, no functions,
 *     no class instances.
 */

import type { RealtimeEphemeralToken, RealtimeSessionRequest } from './realtime.js';
import type {
  Agent,
  AgentId,
  HarnessRule,
  RealtimeToolDefinition,
  SerializableStore,
  TranscriptItem,
  WorldStateBrief,
} from './state.js';
import type { CodexEvent } from './codex.js';

// ─── Channel enum ────────────────────────────────────────────────────────

export const IpcChannel = {
  // ─── Legacy boilerplate (W1 scaffolding) ──────────────────────────────
  HotkeyPressed: 'director:hotkey-pressed',
  GetDormantState: 'director:get-dormant-state',
  RequestSummon: 'director:request-summon',
  RealtimeMintToken: 'director:realtime-mint-token',

  // ─── realtime.* ───────────────────────────────────────────────────────
  RealtimeSessionUpdate: 'realtime.sessionUpdate',
  RealtimeRotationReady: 'realtime.rotationReady',
  RealtimeDisconnect: 'realtime.disconnect',

  // ─── tool.* ───────────────────────────────────────────────────────────
  ToolCall: 'tool.call',
  ToolResult: 'tool.result',
  ToolProactiveAnnounce: 'tool.proactiveAnnounce',

  // ─── state.* ──────────────────────────────────────────────────────────
  StatePatch: 'state.patch',
  StateHydrate: 'state.hydrate',
  StateSnapshotRequest: 'state.snapshotRequest',
  StateSync: 'state.sync',

  // ─── hotkey.* (modern) ────────────────────────────────────────────────
  HotkeyRegisterFailed: 'hotkey.registerFailed',

  // ─── mic.* ────────────────────────────────────────────────────────────
  MicToggle: 'mic.toggle',
  MicStatus: 'mic.status',
  MicPermissionDenied: 'mic.permissionDenied',

  // ─── audio.* ──────────────────────────────────────────────────────────
  AudioCue: 'audio.cue',

  // ─── app.* ────────────────────────────────────────────────────────────
  AppQuit: 'app.quit',
  AppReady: 'app.ready',
  AppError: 'app.error',

  // ─── window.* (Strip geometry, right-edge anchored in main) ───────────
  WindowStripResize: 'window.strip.resize',

  // ─── canvas.* (tool-router → canvas window — convenience alias) ────────
  // Canonical canvas channels live in shared/canvas-ipc.ts; W3's
  // tool-router re-emits `canvas.render` here so anything subscribed to
  // the main bus can observe it. The Canvas BrowserWindow listens on
  // `CanvasIpcChannel.Render` (same string value).
  CanvasRender: 'canvas.render',

  // ─── ask.* (tool-router ⇄ strip renderer) ─────────────────────────────
  /** Main → renderer: open an ask-user prompt (voice or click resolves). */
  AskShow: 'ask.show',
  /** Renderer → main: user answered (or timeout fired). */
  AskAnswer: 'ask.answer',

  // ─── Append-only additions (see docs/contracts.md § 13.1) ─────────────
  // Each new entry on its own line, signed with worker comment.
  // Examples (uncomment + edit when you add yours):
  //   CodexEvent: 'codex.event',                  // Worker 1 — P4
  //   SidestoreSnapshot: 'sidestore.snapshot',    // Worker 3 — P3
  //   AudioCueRequest: 'audio.cue.request',       // Worker 3 — P5
  // Do NOT modify entries above this marker without a contract change
  // (docs(contracts): change <name> commit).
  PlannerConsult: 'planner.consult',                  // Worker 1 — P3
  PlannerReasoningDelta: 'planner.reasoning.delta',   // Worker 1 — P3
  SidestoreSnapshot: 'sidestore.snapshot',            // Worker 3 — P3
  // ─── codex.* (real Codex subprocesses) ────────────────────────────────
  CodexEvent: 'codex.event',                          // Worker 1 — P4
  CodexDispatch: 'codex.dispatch',                    // Worker 1 — P4
  CodexAbort: 'codex.abort',                          // Worker 1 — P4
  // ─── § canvas-degradation (W5 — P6.6) ─────────────────────────────────
  // ApiKeyMissing canvas card writes the user-provided OPENAI_API_KEY back
  // to disk via the main process. Keychain mode is gated by the env flag
  // `DIRECTOR_USE_KEYCHAIN=1` and NOT implemented in this lane — main
  // currently always writes to the project `.env` file (atomic semantics).
  AppWriteEnv: 'app.writeEnv',                        // Worker 5 — P6.6
  // ─── § realtime-rotation + reconnect (W2 — P6.1 + P6.2) ───────────────
  /** Renderer → main: lifecycle FSM hit T+55, build Brief + mint Session_B. */
  RealtimeRotationRequest: 'realtime.rotationRequest', // Worker 2 — P6.1
  /** Renderer → main: reconnect-loop state change (degraded / retrying / live). */
  RealtimeReconnectState: 'realtime.reconnectState',   // Worker 2 — P6.2
} as const;

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel];

// ─── Common envelopes ────────────────────────────────────────────────────

export type IpcAck<T = void> =
  | (T extends void ? { ok: true } : { ok: true } & T)
  | { ok: false; error: string };

// ─── realtime.* payloads ─────────────────────────────────────────────────

export interface RealtimeMintTokenRequest {
  voice: 'marin' | 'cedar';
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  tools: RealtimeToolDefinition[];
  instructions: string;
}

export type RealtimeMintTokenResponse =
  | { ok: true; token: string; expiresAt: number; sessionId: string }
  | { ok: false; error: string };

export interface RealtimeSessionUpdatePayload {
  patch: Partial<{
    voice: 'marin' | 'cedar';
    instructions: string;
    tools: RealtimeToolDefinition[];
  }>;
}

export interface RotationReadyPayload {
  newToken: string;
  newSessionId: string;
  expiresAt: number;
  brief: WorldStateBrief;
}

export interface RealtimeDisconnectPayload {
  reason: 'user-quit' | 'rotation-complete' | 'auth-failed' | 'network';
  sessionId: string;
}

// ─── § realtime-rotation + reconnect payloads (W2 — P6.1 + P6.2) ─────────

export interface RealtimeRotationRequestPayload {
  /** Renderer-side correlation id so the response can be matched. */
  requestId: string;
  /** Identifier the renderer uses to refer to Session_A in its logs. */
  fromSessionId?: string | null;
  /** Optional voice override (rotation usually keeps the same voice). */
  voice?: 'marin' | 'cedar';
}

export type RealtimeRotationResponse =
  | {
      ok: true;
      requestId: string;
      newToken: string;
      newSessionId: string;
      expiresAt: number;
      brief: WorldStateBrief;
    }
  | { ok: false; requestId: string; error: string };

/**
 * Renderer → main fire-and-forget event reporting the reconnect FSM state.
 * Main observes this to surface tray badge / macOS notifications. The
 * renderer-side store is the source of truth for visual UI; this channel
 * is for cross-window / cross-process effects.
 */
export interface RealtimeReconnectStatePayload {
  state: 'live' | 'degraded' | 'retrying' | 'offline-persistent';
  /** 0 = no attempts yet; increments after each failed retry. */
  attempt: number;
  /** Last error message, if any. */
  lastError?: string;
  /** ms since the disconnect started. */
  outageMs: number;
}

// ─── tool.* payloads ─────────────────────────────────────────────────────

export type ToolName =
  | 'consult_director'
  | 'dispatch_agent'
  | 'update_harness'
  | 'render_canvas'
  | 'dismiss_canvas'
  | 'record_decision'
  | 'ask_user'
  | 'read_world_state'
  | 'canvas_response'
  | 'dispatch_agent_mock';

export interface ToolCallRequest {
  callId: string;
  name: ToolName;
  args: unknown;
  realtimeItemId: string;
}

export type ToolCallResponse =
  | { ok: true; callId: string; output: unknown; latencyMs: number }
  | { ok: false; callId: string; error: string; latencyMs: number };

export interface ToolResultPayload {
  callId: string;
  output: unknown;
  /**
   * If true, renderer should inject the result as a synthetic
   * `conversation.item.create` (`function_call_output`) + `response.create`.
   * If false, the result is informational only (orchestrator side-effect).
   */
  asSyntheticItem: boolean;
}

export interface ProactiveAnnouncePayload {
  text: string;
  reason: 'agent_blocked' | 'agent_done' | 'rotation_warning' | 'rate_limit';
  metadata?: Record<string, unknown>;
}

// ─── state.* payloads ────────────────────────────────────────────────────

export type StatePatchDomain =
  | 'agents'
  | 'harness'
  | 'canvas'
  | 'transcript'
  | 'goal'
  | 'realtime'
  | 'strip';

export type StatePatchSource = 'main' | 'codex' | 'orchestrator' | 'side-store';

export interface StatePatchPayload {
  domain: StatePatchDomain;
  patch: unknown;
  source: StatePatchSource;
  at: number;
}

export interface StateHydratePayload {
  harness: HarnessRule[];
  agents: Record<AgentId, Agent>;
  goal: string | null;
  recentTranscript: TranscriptItem[];
  resumedFrom: { sessionId: string; at: number } | null;
}

export type StateSnapshotResponse =
  | { ok: true; snapshot: SerializableStore }
  | { ok: false; error: string };

export interface StateSyncPayload {
  full: SerializableStore;
  reason: 'crc-mismatch' | 'forced-resync';
}

// ─── hotkey.* payloads ───────────────────────────────────────────────────

export type HotkeyChord =
  | 'cmd+shift+space'
  | 'cmd+shift+m'
  | 'cmd+period'
  | 'esc';

/**
 * Payload for the canonical `hotkey.pressed` event. The legacy
 * `director:hotkey-pressed` channel carries no payload (W1 scaffolding) —
 * once main is upgraded, switch to this payload + the new channel name.
 */
export interface HotkeyPressedPayload {
  chord: HotkeyChord;
  phase: 'down' | 'up';
  durationMs?: number;
  timestamp: number;
}

export interface HotkeyRegisterFailedPayload {
  chord: string;
  reason: string;
  alternatives: string[];
}

// ─── mic.* payloads ──────────────────────────────────────────────────────

export interface MicToggleRequest {
  muted: boolean;
}

export type MicToggleResponse =
  | { ok: true; muted: boolean }
  | { ok: false; error: string };

export interface MicStatusPayload {
  state: 'muted' | 'tap-open' | 'hold-open';
  inputLevel: number;
}

export interface MicPermissionDeniedPayload {
  systemSettingsDeeplink: string;
}

// ─── audio.* payloads ────────────────────────────────────────────────────

export type AudioCueName =
  | 'confirm'
  | 'tick'
  | 'escalation'
  | 'done'
  | 'recognized';

export interface AudioCuePayload {
  cue: AudioCueName;
  gain?: number;
}

// ─── app.* payloads ──────────────────────────────────────────────────────

export type AppQuitResponse = { ok: true } | { ok: false; error: string };

export interface AppReadyPayload {
  version: string;
  protocolVersion: number;
  platform: 'darwin';
  sessionDirectory: string;
  hasResumeAvailable: boolean;
}

export type AppErrorKind =
  | 'realtime'
  | 'orchestrator'
  | 'codex'
  | 'disk'
  | 'auth'
  | 'hotkey';

export interface AppErrorPayload {
  id: string;
  kind: AppErrorKind;
  message: string;
  severity: 'info' | 'warn' | 'error';
  recoverable: boolean;
}

// ─── window.* payloads ───────────────────────────────────────────────────

export interface StripResizeRequest {
  /** Logical pixel width. */
  width: number;
  /** Logical pixel height. */
  height: number;
}

export type StripResizeResponse = { ok: true } | { ok: false; error: string };

// ─── canvas.* payloads (tool-router convenience) ─────────────────────────

/**
 * Payload for `canvas.render` when re-broadcast on the main IPC bus. The
 * Canvas BrowserWindow's renderer subscribes via `CanvasIpcChannel.Render`
 * (same wire string) — see shared/canvas-ipc.ts for the authoritative
 * payload type. This mirror is the minimal subset the tool-router fires.
 */
export interface CanvasRenderBroadcastPayload {
  component: string;
  props: Record<string, unknown>;
  component_id?: string;
  call_id?: string;
  autoDismissMs?: number;
}

// ─── ask.* payloads ──────────────────────────────────────────────────────

export interface AskShowPayload {
  /** Unique id correlating this prompt with its eventual answer. */
  ask_id: string;
  /** Spoken / written question to surface to the user. */
  question: string;
  /** Optional canonical option labels. */
  options?: string[];
  /** Tool-call id, when the prompt originated from a tool router. */
  call_id?: string;
}

export interface AskAnswerPayload {
  ask_id: string;
  /** User's resolved answer text. `"timeout"` if the prompt expired. */
  answer: string;
}

// ─── Legacy boilerplate types (W1 scaffolding) ───────────────────────────

export interface DormantState {
  dormant: boolean;
}

export type HotkeyListener = () => void;

/**
 * Shape exposed on `window.director` via contextBridge. The minimal surface
 * used by the dormant-strip scaffolding. Will grow as each domain
 * (mic, tool, state) lights up.
 */
export interface DirectorBridge {
  /** Subscribe to hotkey events from main. Returns an unsubscribe fn. */
  onHotkey: (cb: HotkeyListener) => () => void;
  /** Request main to attempt a "summon" (programmatic open). */
  requestSummon: () => Promise<void>;
  /** One-shot read of main's dormant-state estimate. */
  getDormantState: () => Promise<DormantState>;
  /** Realtime ephemeral-token broker (W1). */
  realtime: {
    mintToken: (req?: RealtimeSessionRequest) => Promise<RealtimeEphemeralToken>;
  };
  /** Tool dispatch (W1.tools). The renderer with the data channel
   *  forwards function calls into main, which re-broadcasts to every
   *  renderer (Strip + Canvas) and returns a result. W3/W4 will plug in
   *  real handlers; for now main returns an immediate `{ok:true}` stub. */
  tool: {
    call: (req: ToolCallRequest) => Promise<ToolCallResponse>;
    /** Subscribe to broadcast `tool.call` events fired by main when
     *  the realtime layer dispatches. Handlers in any window can pick
     *  these up to render UI / kick off side-effects. */
    onCall: (cb: (req: ToolCallRequest) => void) => () => void;
    /** Subscribe to async tool results (e.g. agent completions injected
     *  from main → renderer with the peer connection). */
    onResult: (cb: (payload: ToolResultPayload) => void) => () => void;
  };
  /** Mic state broadcast (W1.hotkey). The renderer that owns the peer
   *  publishes mic state; any window can subscribe. */
  mic: {
    setStatus: (payload: MicStatusPayload) => void;
    onStatus: (cb: (payload: MicStatusPayload) => void) => () => void;
  };
  /** Strip window geometry control (W2). Main re-anchors to the right edge. */
  window: {
    resizeStrip: (dims: StripResizeRequest) => Promise<StripResizeResponse>;
  };
  /** State-patch fan-out (W3.tool-router). Main pushes typed mutations
   *  that the renderer applies via `state/ipcSync.ts` into the canonical
   *  Zustand store. */
  state: {
    onPatch: (cb: (payload: StatePatchPayload) => void) => () => void;
  };
  /** Ask-user prompt channel (W3.tool-router). Strip renderer surfaces
   *  the prompt and replies via `answer()` once the user responds (voice
   *  resolution or click). */
  ask: {
    onShow: (cb: (payload: AskShowPayload) => void) => () => void;
    answer: (payload: AskAnswerPayload) => void;
  };
  // ─── § codex-event-bridge (W3 — P4) ─────────────────────────────────
  /** Codex pool events broadcast from main on `IpcChannel.CodexEvent`.
   *  The renderer's `state/ipcSync.ts` subscribes and maps each event to
   *  one or more canonical store commands. See docs/contracts.md § 13.1
   *  (append-only marker) and the mapping table in `handleCodexEvent`. */
  codex: {
    onEvent: (cb: (event: CodexEvent) => void) => () => void;
  };
  // ─── § realtime-rotation + reconnect (W2 — P6.1 + P6.2) ─────────────
  /** Realtime rotation + reconnect bridge. Renderer drives the lifecycle
   *  FSM; main provides the cross-process work (mint + read side store +
   *  surface tray badge / notifications via the reconnect-state events). */
  realtimeRotation: {
    /** T+55 trigger: request Session_B + a fresh World State Brief. */
    requestRotation: (
      payload: RealtimeRotationRequestPayload,
    ) => Promise<RealtimeRotationResponse>;
    /** Report renderer-side reconnect FSM state to main (fire-and-forget). */
    reportReconnectState: (payload: RealtimeReconnectStatePayload) => void;
  };
}

declare global {
  interface Window {
    director: DirectorBridge;
  }
}

// ─── Channel → payload map (for typed dispatch helpers) ──────────────────

/** Send-style channels (no ack). */
export interface IpcSendMap {
  [IpcChannel.HotkeyPressed]: void;
  [IpcChannel.RealtimeSessionUpdate]: RealtimeSessionUpdatePayload;
  [IpcChannel.RealtimeRotationReady]: RotationReadyPayload;
  [IpcChannel.RealtimeDisconnect]: RealtimeDisconnectPayload;
  [IpcChannel.ToolResult]: ToolResultPayload;
  [IpcChannel.ToolProactiveAnnounce]: ProactiveAnnouncePayload;
  [IpcChannel.StatePatch]: StatePatchPayload;
  [IpcChannel.StateHydrate]: StateHydratePayload;
  [IpcChannel.StateSync]: StateSyncPayload;
  [IpcChannel.HotkeyRegisterFailed]: HotkeyRegisterFailedPayload;
  [IpcChannel.MicStatus]: MicStatusPayload;
  [IpcChannel.MicPermissionDenied]: MicPermissionDeniedPayload;
  [IpcChannel.AudioCue]: AudioCuePayload;
  [IpcChannel.AppReady]: AppReadyPayload;
  [IpcChannel.AppError]: AppErrorPayload;
  [IpcChannel.CanvasRender]: CanvasRenderBroadcastPayload;
  [IpcChannel.AskShow]: AskShowPayload;
  [IpcChannel.AskAnswer]: AskAnswerPayload;
  // § codex-event-bridge (W3 — P4)
  [IpcChannel.CodexEvent]: CodexEvent;
  // § realtime-rotation + reconnect (W2 — P6.1 + P6.2)
  [IpcChannel.RealtimeReconnectState]: RealtimeReconnectStatePayload;
}

/** Invoke-style channels (request → ack). */
export interface IpcInvokeMap {
  [IpcChannel.GetDormantState]: { request: void; response: DormantState };
  [IpcChannel.RequestSummon]: { request: void; response: void };
  [IpcChannel.RealtimeMintToken]: {
    request: RealtimeSessionRequest | undefined;
    response: RealtimeEphemeralToken;
  };
  [IpcChannel.ToolCall]: {
    request: ToolCallRequest;
    response: ToolCallResponse;
  };
  [IpcChannel.WindowStripResize]: {
    request: StripResizeRequest;
    response: StripResizeResponse;
  };
  [IpcChannel.StateSnapshotRequest]: {
    request: void;
    response: StateSnapshotResponse;
  };
  [IpcChannel.MicToggle]: {
    request: MicToggleRequest;
    response: MicToggleResponse;
  };
  [IpcChannel.AppQuit]: { request: void; response: AppQuitResponse };
  [IpcChannel.SidestoreSnapshot]: {
    request: void;
    response:
      | { ok: true; world: Record<string, unknown> }
      | { ok: false; error: string };
  };
  // § canvas-degradation (W5 — P6.6)
  [IpcChannel.AppWriteEnv]: {
    request: AppWriteEnvRequest;
    response: AppWriteEnvResponse;
  };
  // § realtime-rotation + reconnect (W2 — P6.1)
  [IpcChannel.RealtimeRotationRequest]: {
    request: RealtimeRotationRequestPayload;
    response: RealtimeRotationResponse;
  };
}

// ─── § canvas-degradation payloads (W5 — P6.6) ──────────────────────────
// `AppWriteEnv` lets the Canvas window's ApiKeyMissing card persist a
// user-provided OPENAI_API_KEY (or any whitelisted env key) to the project
// `.env` file via the main process. Main is the only thing on macOS that
// can touch the user's home directory, so this MUST be a main-process
// handler. The handler validates that `key` is on the allow-list and writes
// the value atomically via the same tmp+rename pattern used by side-store.

/** Subset of env keys the handler will write. Keep narrow — every entry is
 *  user-supplied input persisted to disk. */
export type AppWriteEnvKey = 'OPENAI_API_KEY';

export interface AppWriteEnvRequest {
  key: AppWriteEnvKey;
  value: string;
}

export type AppWriteEnvResponse =
  | { ok: true; path: string }
  | { ok: false; error: string };


// ─── Re-export state types so callers only need this import ──────────────

export type {
  Agent,
  AgentId,
  AgentRole,
  AgentStatus,
  CanvasComponentName,
  CanvasComponentProps,
  CanvasState,
  HarnessRule,
  RealtimeStatus,
  RealtimeToolDefinition,
  SerializableStore,
  StripState,
  StripStateKind,
  TranscriptItem,
  WorldStateBrief,
} from './state.js';
