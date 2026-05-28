# Director — IPC Contracts Spec (W3)

Every IPC channel between Electron main and renderer, fully typed. This spec is **implementable as-is**. It descends from `architecture.md` §7 and supersedes the sketch there.

All channels are declared in a single shared file: `apps/director/src/shared/ipc.ts`. The preload re-exports a typed `window.director` surface. No untyped channels in the codebase — CI lints against raw `ipcRenderer.invoke` / `ipcRenderer.on` calls outside the preload.

---

## 1. Channel naming convention

Format: `<domain>.<action>` (lowercase, dot-separated). Verbs use present tense for triggers (`hotkey.pressed`), imperative for commands (`mic.toggle`, `app.quit`). Acks return a `{ ok: boolean; ... }` shape — never throw across the IPC boundary; surface errors as `{ ok: false; error }`.

```ts
export enum IpcChannel {
  RealtimeMintToken      = 'realtime.mintToken',
  RealtimeSessionUpdate  = 'realtime.sessionUpdate',
  RealtimeRotationReady  = 'realtime.rotationReady',
  RealtimeDisconnect     = 'realtime.disconnect',

  ToolCall               = 'tool.call',
  ToolResult             = 'tool.result',
  ToolProactiveAnnounce  = 'tool.proactiveAnnounce',

  StatePatch             = 'state.patch',
  StateHydrate           = 'state.hydrate',
  StateSnapshotRequest   = 'state.snapshotRequest',
  StateSync              = 'state.sync',

  HotkeyPressed          = 'hotkey.pressed',
  HotkeyRegisterFailed   = 'hotkey.registerFailed',

  MicToggle              = 'mic.toggle',
  MicStatus              = 'mic.status',
  MicPermissionDenied    = 'mic.permissionDenied',

  AudioCue               = 'audio.cue',

  AppQuit                = 'app.quit',
  AppReady               = 'app.ready',
  AppError               = 'app.error',
}
```

---

## 2. `realtime.*`

### `realtime.mintToken` — renderer→main (invoke)

```ts
interface RealtimeMintTokenRequest {
  voice: 'marin' | 'cedar';
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  tools: RealtimeToolDefinition[];
  instructions: string;
}

interface RealtimeMintTokenResponse {
  ok: true;
  token: string;
  expiresAt: number;
  sessionId: string;
}
| { ok: false; error: string }
```

**Trigger**: renderer on boot, again every 55min for rotation.
**Consumer**: main `realtime/tokenBroker.ts` calls `POST /v1/realtime/client_secrets`.

### `realtime.sessionUpdate` — main→renderer (send)

```ts
interface RealtimeSessionUpdatePayload {
  patch: Partial<{ voice: string; instructions: string; tools: RealtimeToolDefinition[] }>;
}
```

**Trigger**: harness change requires a live `session.update` to be sent over the data channel (e.g. a new tool added).
**Consumer**: renderer's `realtime/dataChannel.ts` forwards the patch as `session.update`.

### `realtime.rotationReady` — main→renderer (send)

```ts
interface RotationReadyPayload {
  newToken: string;
  newSessionId: string;
  expiresAt: number;
  brief: WorldStateBrief;
}

interface WorldStateBrief {
  harnessRules: string[];
  activeAgents: Array<{ id: string; name: string; role: string; status: string; task: string | null }>;
  goal: string | null;
  lastCanvas: { component: string; props: unknown; awaitingResponse: boolean } | null;
  recentTranscript: TranscriptItem[];
  elapsedMs: number;
}
```

**Trigger**: T+55min, main has minted `Session_B` and built the brief.
**Consumer**: renderer's `realtime/rotationClient.ts` opens the second peer connection, injects the brief, swaps at next silence window (≤200ms).

### `realtime.disconnect` — bidirectional (send)

```ts
interface RealtimeDisconnectPayload {
  reason: 'user-quit' | 'rotation-complete' | 'auth-failed' | 'network';
  sessionId: string;
}
```

**Trigger**: app quit, rotation complete (close old session), or fatal error.
**Consumer**: whoever owns the peer connection closes it gracefully.

---

## 3. `tool.*`

### `tool.call` — renderer→main (invoke)

The most load-bearing channel. Realtime emits a `function_call` on the data channel; the renderer wraps it and ships here.

```ts
interface ToolCallRequest {
  callId: string;
  name: ToolName;
  args: unknown;
  realtimeItemId: string;
}

type ToolName =
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

interface ToolCallResponse {
  ok: true;
  callId: string;
  output: unknown;
  latencyMs: number;
}
| { ok: false; callId: string; error: string; latencyMs: number }
```

**Trigger**: data channel receives `response.function_call_arguments.done` + `response.done` with the call.
**Consumer**: main's dispatch hub (`main/ipc/server.ts`) routes by `name` to the correct handler (orchestrator, harness writer, canvas slice writer, codex supervisor).

### `tool.result` — main→renderer (send) — for async tool completions

Used when a tool that originally returned `{ job_id, status: 'started' }` finally completes — e.g. a Codex agent finished and the orchestrator needs to feed the result back into the Realtime conversation.

```ts
interface ToolResultPayload {
  callId: string;
  output: unknown;
  asSyntheticItem: boolean;
}
```

**Trigger**: Codex `turn.completed`, orchestrator proactive injection.
**Consumer**: renderer's data channel sends `conversation.item.create` (`function_call_output`) + `response.create`.

### `tool.proactiveAnnounce` — main→renderer (send)

```ts
interface ProactiveAnnouncePayload {
  text: string;
  reason: 'agent_blocked' | 'agent_done' | 'rotation_warning' | 'rate_limit';
  metadata?: Record<string, unknown>;
}
```

**Trigger**: orchestrator decides to surface an unprompted utterance.
**Consumer**: renderer sends a `conversation.item.create` system message + `response.create` with `metadata.kind: 'proactive_announcement'`.

### Wire format examples

`render_canvas` call:

```json
{
  "callId": "call_8h2v",
  "name": "render_canvas",
  "args": {
    "component_id": "checkout-aesthetic-1",
    "component": "moodboard",
    "props": {
      "title": "Checkout aesthetic",
      "concepts": [
        { "id": "neon", "label": "Neon Gradient", "description": "Vibrant", "image_url": "...", "palette": ["#0FF","#F0F"] },
        { "id": "matte", "label": "Flat Matte", "description": "Calm premium", "image_url": "...", "palette": ["#1A1A1A","#EAEAEA"] }
      ]
    }
  },
  "realtimeItemId": "item_8h2u"
}
```

Ack: `{ ok: true, callId: "call_8h2v", output: { component_id: "checkout-aesthetic-1" }, latencyMs: 12 }`.

`dispatch_agent_mock` call (hackathon fast path):

```json
{
  "callId": "call_8h2w",
  "name": "dispatch_agent_mock",
  "args": { "agent_id": "maya", "task": "wire the flip animation", "files": ["app/PlaylistCard.tsx"] },
  "realtimeItemId": "item_8h2v"
}
```

Ack returns immediately: `{ ok: true, output: { job_id: "job_01HX...", status: "started" }, latencyMs: 4 }`. Status updates flow later via `state.patch` events.

`ask_user` call (passthrough — no backend work):

```json
{
  "callId": "call_8h2x",
  "name": "ask_user",
  "args": { "question": "Should I mock the Stripe gateway, or wait for keys?" },
  "realtimeItemId": "item_8h2w"
}
```

Ack: `{ ok: true, output: { acknowledged: true }, latencyMs: 1 }` — Realtime asks the user directly via audio; no main-process side effect.

`update_harness` call:

```json
{
  "callId": "call_8h2y",
  "name": "update_harness",
  "args": { "rule": "no gradients ever", "why": "user said so during checkout aesthetic review", "scope": "project" },
  "realtimeItemId": "item_8h2x"
}
```

Ack: `{ ok: true, output: { rule_id: "01HX...", saved: true }, latencyMs: 8 }`. Side-effect: `state.patch` event fires with the new rule appended to `harness`.

---

## 4. `state.*`

### `state.patch` — main→renderer (send)

```ts
interface StatePatchPayload {
  domain: 'agents' | 'harness' | 'canvas' | 'transcript' | 'goal' | 'realtime';
  patch: unknown;
  source: 'main' | 'codex' | 'orchestrator' | 'side-store';
  at: number;
}
```

**Trigger**: any main-side state mutation (agent status change from Codex, harness rule appended, goal updated, etc.).
**Consumer**: renderer's `state/ipcSync.ts` routes to the matching command (`updateAgent`, `addHarnessRule`, etc.).

### `state.hydrate` — main→renderer (send) — boot/resume

```ts
interface StateHydratePayload {
  harness: HarnessRule[];
  agents: Record<string, Agent>;
  goal: string | null;
  recentTranscript: TranscriptItem[];
  resumedFrom: { sessionId: string; at: number } | null;
}
```

**Trigger**: app boot after main reads side-store snapshot; user picks "resume" from Pass 3 3C-1 prompt.
**Consumer**: renderer initializes the store; strip and realtime slices are reset to `dormant`/`idle` regardless.

### `state.snapshotRequest` — main→renderer (invoke)

```ts
() => Promise<{ ok: true; snapshot: SerializableStore }>
```

**Trigger**: main needs the current authoritative renderer state — e.g. before a rotation, before quit, on the 1.5s debounced snapshot tick.
**Consumer**: renderer returns a deep-cloned, non-function-bearing snapshot.

### `state.sync` — main→renderer (send) — reconciliation

```ts
interface StateSyncPayload {
  full: SerializableStore;
  reason: 'crc-mismatch' | 'forced-resync';
}
```

**Trigger**: 250ms CRC heartbeat from main detects drift between its mirror and the renderer's snapshot.
**Consumer**: renderer replaces the store with `full`. Main wins on conflicts (architecture.md §2).

---

## 5. `hotkey.*`

### `hotkey.pressed` — main→renderer (send)

```ts
interface HotkeyPressedPayload {
  chord: 'cmd+shift+space' | 'cmd+shift+m' | 'cmd+period' | 'esc';
  phase: 'down' | 'up';
  durationMs?: number;
  timestamp: number;
}
```

**Trigger**: macOS global hotkey fires via Electron's `globalShortcut`.
**Consumer**: renderer's `commands.summon` (with `mode: 'tap' | 'hold'` derived from `durationMs`), `mute`, `stopCurrent`, or `dismissCanvas`.

### `hotkey.registerFailed` — main→renderer (send)

```ts
interface HotkeyRegisterFailedPayload {
  chord: string;
  reason: string;
  alternatives: string[];
}
```

**Trigger**: on boot, `globalShortcut.register('CommandOrControl+Shift+Space')` returns `false` (Pass 7 7C-1).
**Consumer**: renderer opens a Canvas `options_picker` with the suggested alternatives.

---

## 6. `mic.*`

### `mic.toggle` — renderer→main (invoke)

```ts
({ muted: boolean }) => Promise<{ ok: true; muted: boolean } | { ok: false; error: string }>
```

**Trigger**: user `⌘⇧M` or programmatic mute on rotation.
**Consumer**: main logs the change; renderer actually toggles the MediaStreamTrack. (Main needs to know for tray icon state.)

### `mic.status` — renderer→main (send)

```ts
interface MicStatusPayload {
  state: 'muted' | 'tap-open' | 'hold-open';
  inputLevel: number;
}
```

**Trigger**: VAD-derived input level changes, mode changes.
**Consumer**: main updates tray icon glyph if level threshold crosses.

### `mic.permissionDenied` — renderer→main (send)

```ts
interface MicPermissionDeniedPayload {
  systemSettingsDeeplink: string;
}
```

**Trigger**: `getUserMedia` rejects with `NotAllowedError`.
**Consumer**: main logs; renderer locally opens a Canvas `form` per Pass 2.

---

## 7. `audio.*`

### `audio.cue` — main→renderer (send)

```ts
interface AudioCuePayload {
  cue: 'confirm' | 'tick' | 'escalation' | 'done' | 'recognized';
  gain?: number;
}
```

**Trigger**: main wants a UI sound effect (subtask complete, escalation, harness rule saved).
**Consumer**: renderer's `ui/sound.ts` plays the matching sample via Web Audio API. Volume respects user setting.

---

## 8. `app.*`

### `app.quit` — renderer→main (invoke)

```ts
() => Promise<{ ok: true }>
```

**Trigger**: tray menu, `⌘Q`, or a programmatic shutdown.
**Consumer**: main runs the quit protocol (architecture.md §8): SIGTERM Codex children, flush snapshot, close Realtime, electron quit.

### `app.ready` — main→renderer (send)

```ts
interface AppReadyPayload {
  version: string;
  platform: 'darwin';
  sessionDirectory: string;
  hasResumeAvailable: boolean;
}
```

**Trigger**: main has finished boot (side-store ready, hotkey registered, tray placed).
**Consumer**: renderer triggers strip slide-in animation + onboarding sequence.

### `app.error` — main→renderer (send)

```ts
interface AppErrorPayload {
  id: string;
  kind: 'realtime' | 'orchestrator' | 'codex' | 'disk' | 'auth' | 'hotkey';
  message: string;
  severity: 'info' | 'warn' | 'error';
  recoverable: boolean;
}
```

**Trigger**: any main-side failure that needs UI surfacing.
**Consumer**: renderer's `setError` command (if severity `error`) or quiet log (if `info`).

---

## 9. `canvas.*` and `ask.*` (tool router)

The W3 tool router owns three additional channels beyond the canvas window's own surface (`shared/canvas-ipc.ts`).

### `canvas.render` — main→any (send) — observer bus

Re-broadcast of every Canvas open the tool router triggers. The canonical channel that the Canvas BrowserWindow listens on is `CanvasIpcChannel.Render` (same wire string). The mirror on the main IPC bus is for any other observer (telemetry, future state replication).

```ts
interface CanvasRenderBroadcastPayload {
  component: string;
  props: Record<string, unknown>;
  component_id?: string;
  call_id?: string;
  autoDismissMs?: number;
}
```

**Trigger**: `routeToolCall({name:'render_canvas',...})` or any router-side flash (e.g. `harness_rule_save` after `update_harness`).
**Consumer**: Canvas BrowserWindow (canonical render), plus any other window that subscribed for observability.

### `ask.show` — main→strip renderer (send)

Tool-router prompts the user. The strip renderer surfaces the question (voice + visual) and resolves via `ask.answer`. Main times the prompt out at 60s.

```ts
interface AskShowPayload {
  ask_id: string;          // correlate with the eventual answer
  question: string;
  options?: string[];      // canonical option labels (if any)
  call_id?: string;        // tool-call id when triggered by ask_user
}
```

### `ask.answer` — renderer→main (send)

```ts
interface AskAnswerPayload {
  ask_id: string;
  answer: string;          // "timeout" when the main-side prompt expired
}
```

---

## 10. Renderer-only event: `director:escalation`

Not an Electron IPC channel — a renderer-side `window` CustomEvent. The agent simulator (`renderer/state/sim.ts`) dispatches it the moment the demo's `blockAgent('jin', ...)` fires. The orchestration layer (later wiring) listens, builds a server-initiated `conversation.item.create` + `response.create` per `docs/research/gpt-realtime-2.md` §8, and routes it onto the live Realtime data channel so Director speaks unprompted.

```ts
interface EscalationDetail {
  agent_id: string;          // e.g. 'jin'
  blocker: string;           // human-readable blocker, e.g. 'Stripe staging API key not in env'
  suggested_question: string; // the question Director should ask, verbatim
}

window.dispatchEvent(
  new CustomEvent<EscalationDetail>('director:escalation', { detail }),
);
```

**Trigger**: sim's `blockAgent` step fires at canonical T+1:45 (compressed T+~20s).
**Consumer**: any renderer-side listener — App.tsx logs it today; the orchestration bridge will pick it up next.

This decouples sim → speech: no IPC round-trip, no preload changes, no W1 dependency. The bridge can be swapped in without touching the simulator.

---

## 11. Conventions

- **All channels are declared in `apps/director/src/shared/ipc.ts`** as the `IpcChannel` enum.
- **All payload and response types are exported as named TypeScript interfaces from the same file.** No `unknown`-typed payloads outside the dispatch boundary (which validates and narrows immediately).
- **No untyped channels in the codebase.** The preload exposes `invoke<C extends IpcChannel>` and `on<C extends IpcChannel>` generics; the eslint rule `no-raw-ipc` forbids `ipcRenderer.invoke('...')` outside `preload/index.ts`.
- **All `invoke` channels return `{ ok: true; ... } | { ok: false; error: string }`** — never throw across the boundary.
- **Fire-and-forget events use `send`/`on`**, not `invoke`, and have no return type.
- **Channel names are stable strings** — even though the enum re-keys them, the wire string is the contract. Never rename without bumping a `protocolVersion` in `app.ready`.
- **Payloads must be structured-clone-safe** — no functions, no class instances, no DOM nodes. Plain objects only.
- **Logs**: every IPC roundtrip > 50ms is logged with `{ channel, latencyMs, callId? }` for perf debugging.
