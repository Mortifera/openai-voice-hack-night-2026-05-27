# Director — Contracts

> **Version**: 2026-05-27.4
> **Status**: Source of truth for cross-worker integration. Every agent prompt MUST point at this doc. Every contract change is a commit that updates the version above.

This file is the single shared boundary between workers. If two workers are about to touch the same shape, this is where they agree on it BEFORE writing code. The hackathon retrospective made the diagnosis: subsystems worked in isolation; the integration boundary failed because no canonical contract existed. This is that document.

**Doc vs. code:** this doc describes the **canonical contracts + principles**. The authoritative *full enumeration* of every channel and type lives in:
- `apps/director/src/shared/ipc.ts` — `IpcChannel` enum + all payload interfaces (strip + main IPC)
- `apps/director/src/shared/canvas-ipc.ts` — `CanvasIpcChannel` enum + canvas-window IPC
- `apps/director/src/shared/state.ts` — all state types (Agent, StripState, etc.)
- `apps/director/src/shared/realtime.ts` — Realtime types + `DIRECTOR_INSTRUCTIONS`

When the doc and code disagree, the rule is: **proposing a contract change = a doc commit FIRST, then the code change.** If you find code that drifts from the doc, file a `docs(contracts): clarify <name>` to bring the doc in line, or a `docs(contracts): change <name>` if the code is wrong.

---

## 0. How agents use this doc

Every dispatch prompt includes a `## Contracts` section that links to specific sections of this file by anchor (`docs/contracts.md § 3.2 — tool.call IPC`). Workers read those sections before writing code.

Workers MUST NOT silently invent contracts that aren't here. If a contract is missing, the worker:
1. Names what they think it should be
2. Adds it to this doc as a proposal commit (`docs(contracts): propose <name>`)
3. Pushes, then writes the code

Two workers ending up with different shapes for the same channel = a coordination bug. This doc prevents it.

---

## 1. Process model

```
┌──────────────────────────────────────────────────────────────┐
│  Electron main process                                       │
│  ─ token mint, OpenAI API key, dotenv                        │
│  ─ tray icon + global hotkey                                 │
│  ─ Realtime tool router (intent dispatch)                    │
│  ─ Codex SDK process manager (Phase 4)                       │
│  ─ gpt-5.5 planner client (Phase 3)                          │
│  ─ Side store on disk (harness, decisions, transcript)       │
│  ─ Canvas BrowserWindow lifecycle                            │
└──────────────────────────────────────────────────────────────┘
        ▲     │ IPC (typed channels)
        │     ▼
┌──────────────────────────────────────────────────────────────┐
│  Preload (contextBridge)                                     │
│  ─ window.director.realtime.*                                │
│  ─ window.director.tool.*                                    │
│  ─ window.director.state.*                                   │
│  ─ window.director.canvas.*  (canvas window only)            │
└──────────────────────────────────────────────────────────────┘
        ▲     │
        │     ▼
┌──────────────────────────────────────────────────────────────┐
│  Renderer (React)                                            │
│  ─ RealtimeClient (WebRTC peer + data channel)               │
│  ─ Zustand store (canonical state)                           │
│  ─ Strip + Canvas UI components                              │
│  ─ Sim driver (timer-based agent progression)                │
└──────────────────────────────────────────────────────────────┘
```

**Constraint:** OPENAI_API_KEY lives only in main. Renderer receives short-lived ephemeral Realtime tokens minted on demand.

---

## 2. Shared types

All shared types live in `apps/director/src/shared/`. Importing from this directory is the canonical way to use a type — never redeclare locally.

### 2.1 `Agent` (state.ts)
```ts
export type AgentRole = 'frontend' | 'backend' | 'data' | 'design';
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'error';
export interface Agent {
  id: string;                  // stable per session, e.g. 'maya'
  name: string;                // display name 'Maya'
  role: AgentRole;
  accent: string;              // hex color, no token (Pass 4 identity table)
  status: AgentStatus;
  trail: string;               // italic micro-text shown under name
  files: string[];             // last 3 file paths touched
  blocker?: string;            // populated when status === 'blocked'
  progress?: number;           // 0–1 optional
  startedAt?: number;          // ms epoch
}
```

### 2.2 `StripState` (state.ts)
```ts
export type StripStateKind =
  | 'dormant' | 'connecting' | 'listening' | 'speaking' | 'thinking'
  | 'hive' | 'escalating' | 'error' | 'disconnected';

export type StripState =
  | { kind: 'dormant' }
  | { kind: 'connecting' }
  | { kind: 'listening'; mode: 'tap' | 'hold'; since: number }
  | { kind: 'speaking'; itemId: string; phase: 'commentary' | 'final_answer'; since: number }
  | { kind: 'thinking'; trail: string[]; since: number }
  | { kind: 'hive'; activeAgentId: string | null; since: number }
  | { kind: 'escalating'; agentId: string; blocker: string; since: number }
  | { kind: 'error'; message: string }
  | { kind: 'disconnected' };
```

### 2.3 `CanvasState` (state.ts)
```ts
export interface CanvasState {
  open: boolean;
  componentId?: string;         // orchestrator-generated, correlates render → response
  component?: string;           // 'moodboard' | 'artifact_preview' | 'harness_rule_save' | ...
  props?: Record<string, unknown>;
  awaitingResponse: boolean;
  callId?: string;              // ties to original Realtime tool call
}
```

### 2.4 `HarnessRule` (state.ts)
```ts
export interface HarnessRule {
  rule: string;
  why: string;
  timestamp: number;
}
```

### 2.5 `TranscriptItem` (state.ts)
```ts
export interface TranscriptItem {
  role: 'user' | 'assistant' | 'system';
  text: string;
  phase?: 'commentary' | 'final_answer';   // per gpt-realtime-2 §preamble
  timestamp: number;
  itemId?: string;
}
```

### 2.6 `Mixtape` (examples/mixtape/lib/schema.ts)
```ts
export interface Track {
  title: string;
  artist: string;
  runtime: string;             // 'M:SS'
}
export interface Mixtape {
  id: string;                  // short share id
  vibe: string;                // user's freetext mood
  tracks: Track[];
  coverUrl?: string;           // pre-gen image or generated
  createdAt: number;
}
```

### 2.7 `RealtimeEphemeralToken` (realtime.ts)
```ts
export interface RealtimeEphemeralToken {
  value: string;
  expiresAt: number;           // ms epoch
}
```

---

## 3. IPC channels

Channel names are **canonical strings**. The full enum is the authoritative list — this table covers the **core canonical channels every worker needs to know** plus naming conventions. Never use string literals — always import from the enum.

**Files**:
- `apps/director/src/shared/ipc.ts` exports the `IpcChannel` const + all payload type interfaces (Strip + main IPC surface)
- `apps/director/src/shared/canvas-ipc.ts` exports `CanvasIpcChannel` separately (Canvas BrowserWindow has its own preload + bridge)

**Naming convention** (apply to all new channels):
- Modern: `<domain>.<action>` (`tool.call`, `state.patch`, `realtime.sessionUpdate`)
- Domains in use: `realtime · tool · state · hotkey · mic · audio · app · window · canvas · ask`
- **Legacy carve-out**: four `director:*` channels predate the convention (`director:hotkey-pressed`, `director:get-dormant-state`, `director:request-summon`, `director:realtime-mint-token`). They keep their wire strings to avoid breaking the W1 scaffold. Don't add new `director:*` channels.

**Envelope shape** for invoke responses: `IpcAck<T> = { ok: true; ...T } | { ok: false; error: string }`.

### Core canonical channels (subset)

| Channel | Direction | Payload type | Trigger | Consumer |
|---|---|---|---|---|
| `director:realtime-mint-token` (legacy) | invoke renderer→main | `RealtimeMintTokenRequest` → `RealtimeMintTokenResponse` | RealtimeClient.connect() | main: mintEphemeralToken() |
| `realtime.sessionUpdate` | invoke renderer→main | `RealtimeSessionUpdatePayload` | mid-session reconfig | main: forwards to Realtime API |
| `realtime.rotationReady` | send main→renderer | `RotationReadyPayload` | 55-min rotation primed | renderer: World State Brief swap |
| `tool.call` | invoke renderer→main, then main→renderer broadcast | `ToolCallRequest` → `ToolCallResponse` | Realtime function_call.done event | main: tool-router |
| `tool.result` | send main→renderer | `ToolResultPayload` | tool-router completes | renderer: realtime client (for round-trip back to Realtime) |
| `canvas.render` | send (both directions accepted) | `CanvasRenderPayload` | tool-router OR dev hotkey | canvas window renderer |
| `canvas.dismiss` | send | `CanvasDismissPayload` | tool-router OR user gesture | canvas window |
| `canvas.user_response` | send canvas→main | `CanvasUserResponsePayload` | user clicks tile / button | main: relays to renderer + Realtime |
| `state.patch` | send main→renderer | `StatePatchPayload` | main needs to mutate renderer state | renderer: ipcSync.ts |
| `hotkey.pressed` | send main→renderer | (none) | global Hyper-Space pressed | renderer: App.tsx |
| `mic.status` | send renderer→main | `MicStatusPayload` | mic mode changes | main: updates tray icon |
| `ask.show` | send main→renderer | `AskShowPayload` | tool-router handling ask_user | renderer: shows prompt |
| `ask.answer` | send renderer→main | `AskAnswerPayload` | user answers ask prompt | main: resolves ask_user promise |
| `audio.cue` | send main→renderer | `AudioCuePayload` | sim/state needs to play a cue | renderer: audio module |
| `app.quit` | send renderer→main | (none) | tray menu Quit | main: app.quit() |
| `strip.resize` | invoke renderer→main | `StripResizeRequest` → `StripResizeResponse` | stripState changes | main: setBounds with animate |

### 3.1 `ToolCallRequest` / `ToolCallResponse` (canonical shape)

```ts
export type ToolName = 'render_canvas' | 'dispatch_agent_mock' | 'ask_user' | 'update_harness' | 'consult_director';

export interface ToolCallRequest {
  callId: string;              // Realtime's function-call ID
  name: ToolName;
  args: Record<string, unknown>;
  realtimeItemId: string;
}

export interface ToolCallResponse {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}
```

### 3.2 `CanvasRenderPayload`
```ts
export interface CanvasRenderPayload {
  component: string;           // see § 4 for valid names
  props: Record<string, unknown>;
  componentId?: string;        // for canvas_response correlation
  callId?: string;             // ties to originating tool call
  autoDismissMs?: number;      // optional auto-fade
}
```

### 3.3 `CanvasUserResponsePayload`
```ts
export interface CanvasUserResponsePayload {
  componentId: string;
  callId?: string;
  value: unknown;              // shape varies by component (see § 4)
}
```

---

## 4. Realtime tool definitions

These are the tools the Realtime session is told about via `session.update`. Schemas here are the source of truth — `tools` array in session.update mirrors this.

### 4.1 `render_canvas`
```jsonc
{
  "name": "render_canvas",
  "description": "Open the GenUI Canvas with a typed component.",
  "parameters": {
    "type": "object",
    "required": ["component"],
    "properties": {
      "component": { "type": "string", "enum": ["moodboard", "options_picker", "code_preview", "form", "artifact_preview", "harness_rule_save", "agent_pod"] },
      "props": { "type": "object" },
      "component_id": { "type": "string" }
    }
  }
}
```
**Response shape from user**: `{ value: ComponentSpecific }` via canvas.user_response.
- `moodboard` → `{ concept_id: string }`
- `options_picker` → `{ option_ids: string[] }`
- `artifact_preview` → `{ action: 'ship' | 'iterate' | 'discard' }`
- `harness_rule_save` → `{ dismissed: true, reason: 'auto-fade' }`

### 4.2 `dispatch_agent_mock`
```jsonc
{
  "name": "dispatch_agent_mock",
  "parameters": {
    "type": "object",
    "required": ["name", "role", "task"],
    "properties": {
      "name": { "type": "string" },
      "role": { "type": "string", "enum": ["frontend", "backend", "data", "design"] },
      "task": { "type": "string" }
    }
  }
}
```
**Behavior**: adds agent to store with status:'working', trail=task. First call starts the sim (Phase 4: spawns a real Codex subprocess).

### 4.3 `ask_user`
```jsonc
{
  "name": "ask_user",
  "parameters": {
    "type": "object",
    "required": ["question"],
    "properties": {
      "question": { "type": "string" },
      "options": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```
**Behavior**: Director speaks the question; awaits user voice or click; returns `{ answer: string }`. 60s timeout.

### 4.4 `update_harness`
```jsonc
{
  "name": "update_harness",
  "parameters": {
    "type": "object",
    "required": ["rule", "why"],
    "properties": {
      "rule": { "type": "string" },
      "why": { "type": "string" }
    }
  }
}
```
**Behavior**: appends to harness.json on disk, triggers `harness_rule_save` Canvas flash, returns `{ ok: true, harness_count: number }`.

### 4.5 `consult_director` (Phase 3)
```jsonc
{
  "name": "consult_director",
  "parameters": {
    "type": "object",
    "required": ["prompt"],
    "properties": {
      "prompt": { "type": "string" },
      "context": { "type": "object" }
    }
  }
}
```
**Behavior**: calls gpt-5.5 via Responses API, streams reasoning summary back as Realtime audio narration. Returns `{ summary: string, decisions: string[] }`.

---

## 5. State machine

Canonical Zustand store: `apps/director/src/renderer/src/state/store.ts` exports `useStore`. Full shape (per state-machine.md):

```ts
interface Store {
  strip: StripState;
  mic: { muted: boolean; mode: 'idle' | 'tap-open' | 'hold-open' };
  agents: Record<string, Agent>;
  canvas: CanvasState;
  thinkingTrail: string[];
  harness: HarnessRule[];
  transcript: TranscriptItem[];
  realtimeStatus: 'idle' | 'minting' | 'getting-mic' | 'connecting' | 'connected' | 'closed' | 'error';

  // Actions
  summon: (mode: 'tap' | 'hold') => void;
  mute: () => void;
  setListening: (mode: 'tap' | 'hold') => void;
  setSpeaking: (itemId: string, phase: 'commentary' | 'final_answer') => void;
  setThinking: () => void;
  appendThinkingTrail: (line: string) => void;
  enterHive: () => void;
  addAgent: (a: Omit<Agent, 'status' | 'startedAt'> & { task: string }) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  blockAgent: (id: string, blocker: string) => void;
  resolveAgent: (id: string, trail?: string) => void;
  completeAgent: (id: string, files?: string) => void;
  failAgent: (id: string, err: string) => void;
  openCanvas: (component: string, props: object, componentId?: string, callId?: string) => void;
  dismissCanvas: () => void;
  submitCanvasResponse: (value: unknown) => void;
  addHarnessRule: (rule: HarnessRule) => void;
  appendTranscript: (item: TranscriptItem) => void;
  setRealtimeStatus: (s: Store['realtimeStatus']) => void;
}
```

**Legal-transition rule**: actions guard against illegal states (e.g., `setListening` only valid from dormant/speaking/thinking/hive). If called from a wrong state, action no-ops + logs.

---

## 6. Side store

Lives at `~/.director/sessions/<session-id>/`. Atomic writes (write to `.tmp`, rename).

| File | Schema | Updated by |
|---|---|---|
| `harness.json` | `HarnessRule[]` | tool-router on update_harness |
| `decisions.jsonl` | one decision per line `{ at, kind, payload }` | sim + tool-router |
| `agents/<agent-id>.json` | `Agent` snapshot | sim on every patch (debounced 100ms) |
| `transcript.jsonl` | one `TranscriptItem` per line | realtime client on each event |
| `world-state.json` | derived view: `{ active_agents, harness, current_task, last_canvas }` | rebuilt before Realtime session rotation (Phase 6) |

---

## 7. DOM events (renderer-internal)

Custom events on `window` for renderer-internal pub/sub.

| Event | Payload (in `detail`) | Fired by | Listened by |
|---|---|---|---|
| `director:escalation` | `{ agent_id, blocker, suggested_question }` | sim on blockAgent | App.tsx → Realtime injection |
| `director:harness-saved` | `{ rule, count }` | store.addHarnessRule | tray badge updater |
| `director:tool-resolved` | `{ callId, result }` | tool-router | log subscribers |

---

## 8. File ownership

Each path has one owning worker. Cross-worker edits require a doc commit first.

### 8.1 Worker → role mapping

| Worker | Role label | Scope |
|---|---|---|
| **Main** | `ORCH` | Orchestrator (me / this Claude session). Maintains contracts.md, dispatches workers, reviews at gates, owns cross-cutting integration that no single worker can do alone. No code files owned outright — but Main may pre-stake markers in shared files (see § 13.1). |
| **Worker 1** | `MAIN` | Electron main process |
| **Worker 2** | `VOICE` | Realtime WebRTC + session lifecycle |
| **Worker 3** | `STATE` | Zustand + IPC contracts + sim + side store |
| **Worker 4** | `UI` | Strip + Chat + captions + onboarding |
| **Worker 5** | `CANVAS` | Canvas BrowserWindow + GenUI components |

### 8.2 Path → owner

| Path | Owner | Notes |
|---|---|---|
| `apps/director/src/main/index.ts` | W1 (MAIN) | Boot, windows, tray, hotkeys |
| `apps/director/src/main/realtime.ts` | W1 (MAIN) | Token mint (proxy only) |
| `apps/director/src/main/tool-router.ts` | W1 (MAIN) | Tool dispatch |
| `apps/director/src/main/canvas.ts` | W5 (CANVAS) | Canvas window lifecycle — file lives in main/ but Canvas owns |
| `apps/director/src/main/planner.ts` (new, P3) | W1 (MAIN) | gpt-5.5 client |
| `apps/director/src/main/codex-pool.ts` (new, P4) | W1 (MAIN) | Codex spawn manager |
| `apps/director/src/main/side-store.ts` (new, P3) | **W3 (STATE)** | Physically in main/ but owned by W3 — implements state persistence contract |
| `apps/director/src/preload/index.ts` | W1 (MAIN) | Strip preload |
| `apps/director/src/preload/canvas.ts` | W5 (CANVAS) | Canvas preload |
| `apps/director/src/renderer/src/realtime/*` | W2 (VOICE) | WebRTC client + RealtimeClient class |
| `apps/director/src/renderer/src/state/*` | W3 (STATE) | Store + sim + selectors + ipcSync |
| `apps/director/src/renderer/src/components/*` | W4 (UI) | Strip components + chat |
| `apps/director/src/renderer/src/canvas/*` | W5 (CANVAS) | Canvas window React tree |
| `apps/director/src/renderer/src/styles/*` | W4 (UI) | globals.css |
| `apps/director/src/renderer/src/assets/*` | W5 (CANVAS) | Pre-gen images |
| `apps/director/src/renderer/src/hooks/*` | **shared** | Each hook file owned by the worker who wrote it — see § 13.2 App.tsx convention |
| `apps/director/src/renderer/src/audio/*` (new, P5) | W3 (STATE) | Audio cue synthesis — state-driven |
| `apps/director/src/renderer/src/App.tsx` | W4 (UI) | Only W4 edits — see § 13.2 |
| `apps/director/src/shared/state.ts` | W3 (STATE) | Canonical state types |
| `apps/director/src/shared/ipc.ts` | **shared (anchor)** | See § 13.1 reserved-extension anchor |
| `apps/director/src/shared/realtime.ts` | W2 (VOICE) | Realtime types + DIRECTOR_INSTRUCTIONS |
| `apps/director/src/shared/canvas-ipc.ts` | W5 (CANVAS) | Canvas channels (separate from main IPC) |
| `examples/mixtape/*` | Phase 0 done | No active worker; if real Codex completes TODOs (P4), Worker 5 verifies the iframe punchline |
| `docs/*` | Main | Workers may read freely. Edits via doc-commit (see § 11). |

---

## 9. Forbidden patterns

### 9.1 macOS-reserved keyboard shortcuts (NEVER bind globally)
- `⌘Space` — Spotlight
- `⌃Space` — Input source
- `⌘⇧Space` — Character viewer (most setups; usable in dev but unreliable)
- `⌘⇧3 / ⌘⇧4 / ⌘⇧5 / ⌘⇧6` — Screenshot tools
- `⌘⌥M` — Window minimize
- `⌘W` — Close window
- `⌘Q` — Quit
- `⌘H / ⌘⌥H` — Hide / Hide others
- `F1–F12` — Function keys (many remapped by OS to brightness/volume)

**Use Hyper chord** `Control+Alt+Cmd+<letter>` — unbound by default. Example: `⌃⌥⌘M` for Moodboard, `⌃⌥⌘Space` for summon (instead of `⌘⇧Space`).

### 9.2 Electron BrowserWindow flag conflicts
- `frame: false` + `titleBarStyle: 'hidden'` → traffic lights leak on macOS. Use only one.
- `type: 'panel'` requires explicit `closable: false` to remove the red close dot.
- `transparent: true` requires `body { background: transparent; }` in CSS or the renderer fills white.
- `sandbox: true` + non-`.cjs` preload extension can silently break `contextBridge.exposeInMainWorld` — verify preload runs via top-of-file `console.log('[preload] loaded')`.

### 9.3 Styling
- Never use hex literals in components. Reference CSS vars via Tailwind utilities (`text-text-primary`, `bg-status-working`) or `$variable-name` in inline styles.
- Never use linear `transition`. All animation goes through Framer Motion springs.

### 9.4 Imports
- Use `@shared/...` or relative imports — never deep `../../../../`.
- Never import from `src/main/*` in renderer code or vice versa. Cross-process = IPC only.

---

## 10. Verification protocol (every worker's DoD)

Every dispatch task ends with this block:

```
## Verify (must pass before pushing)
1. App launches: `pnpm --filter director dev` → no console errors
2. Trigger the code path you added (specific click / hotkey / event)
3. Open devtools, confirm:
   - window.director exists (if you touched preload)
   - The expected store state / IPC event / DOM event fires
   - No red errors in console or main-process logs
4. If UI-touching: take a screenshot. Compare to the Pencil frame referenced in the prompt (use mcp__pencil__get_screenshot if available).
5. Run `pnpm --filter director typecheck` and `pnpm --filter director build` — both clean.
6. Only then: git add → commit → push.
```

**This is non-negotiable.** Workers who skip the integration-boundary verification create the exact failure mode that broke the hackathon.

---

## 11. Versioning + change protocol

Every contract change is a commit. Commit message format:
- `docs(contracts): propose <name>` — adding a new contract
- `docs(contracts): change <name>` — modifying an existing one
- `docs(contracts): clarify <name>` — non-breaking wording fix

After any change, bump the version line at top of this file (`Version: YYYY-MM-DD.N`).

Workers `git pull` and re-read this file at the start of every task. If the version they read matches the version they reference in their work, contracts are aligned. If not, they stop and re-orient.

---

## 12. Agent prompt template

Every dispatch prompt MUST use this structure:

```markdown
🎯 GOAL (one line): <concrete observable outcome>

## Required reading
- docs/contracts.md § <specific sections by anchor>
- docs/<other-doc>.md § <section>
- apps/director/src/<file>.ts (read first to mirror conventions)

## Contracts referenced
- IPC channel: `<channel-name>` § 3.X
- Type: `<TypeName>` § 2.X
- Tool: `<tool-name>` § 4.X

## File boundaries
CAN touch: <list of paths>
CANNOT touch: <list of paths owned by other roles>

## Forbidden patterns
- (References § 9 of contracts.md plus task-specific)

## Tasks (ship each as separate commit + push)
1. <task name>
   - What: <one line>
   - Where: <file path>
   - How: <2-3 sentences with code sketch if needed>
2. <next task>

## Verify (DoD per § 10 of contracts.md)
1-6. <verbatim from § 10>

## STOP_IF
- If you complete scope before budget, STOP. Do not pad work.
- If contracts in § X conflict with what you're about to write, STOP and propose a contract change first.

## Commit rules
- No co-signing (per CLAUDE.md).
- `git add → commit → push` after each task.
- App must launch after every commit.
```

---

## 13. Anti-collision protocol

Distilled from the hackathon retrospective. The exact bug that broke us was two workers (W1 + W3) both editing `shared/ipc.ts` in the same window without coordination. Below codifies the conventions that prevent it.

### 13.1 Reserved-extension anchor (shared/ipc.ts and shared/state.ts)

Files multiple workers extend get a clearly labeled marker block. Workers **append below the marker**, on new lines. No worker rewrites or reorders existing entries.

In `apps/director/src/shared/ipc.ts`, the marker looks like:

```ts
// ─── Append-only additions (see docs/contracts.md § 13.1) ──────────────
// Each new entry on its own line. Signed with worker comment.
//   PlannerConsult: 'planner.consult',  // Worker 1 — P3
//   CodexEvent: 'codex.event',          // Worker 1 — P4
// Do not modify entries above this marker without a contract change.
```

If you need to MODIFY an existing entry, that's a contract change — doc commit to `contracts.md` first, then code.

Main pre-stakes this marker before any phase that introduces new channels. Workers append below.

### 13.2 The App.tsx hook convention

`apps/director/src/renderer/src/App.tsx` is owned exclusively by Worker 4 (UI). Any other worker that needs a side effect, listener, or hook in the renderer:

1. Writes a hook file in `apps/director/src/renderer/src/hooks/` (e.g., `useEscalationBridge.ts`, `useReconnectNotice.ts`, `useAudioCueRouter.ts`).
2. Exports a default function taking whatever it needs as parameters; returns void or a cleanup.
3. Worker 4 imports + mounts it in App.tsx as a single one-line call. Worker 4 is the only writer to App.tsx.

This way no two workers ever edit App.tsx at the same time.

### 13.3 Path-vs-role ownership

File path doesn't determine ownership. The owner is named in § 8.2. Path-vs-role exceptions:

| File | Path implies | Actually owned by | Why |
|---|---|---|---|
| `src/main/side-store.ts` | W1 (MAIN process) | **W3 (STATE)** | Implements the state persistence contract; main process is just where Node FS lives |
| `src/main/canvas.ts` | W1 (MAIN process) | **W5 (CANVAS)** | Canvas window lifecycle is Canvas's concern |
| `src/preload/canvas.ts` | W1 (MAIN process) | **W5 (CANVAS)** | Same — Canvas owns its bridge |
| `src/renderer/src/audio/*` | W4 (UI) | **W3 (STATE)** | Audio cues triggered by state machine; not visual |

When in doubt, propose a row in § 8.2 first.

### 13.4 New-file conflict resolution

Two workers both proposing the same new file: first one to commit a `docs(contracts): propose <path>` claims ownership. Section 8.2 row added in the same commit.

### 13.5 Pre-dispatch collision check (Main's job before any batch)

Before dispatching a parallel batch, Main:

1. Walks the Gantt for the time window of the batch
2. For each shared file, lists workers active in that window
3. Resolves any collision via one of:
   - **Sequencing** — one worker waits for the other to commit + push first
   - **Splitting** — extract conflict zone into a new file owned by one worker
   - **Anchor pattern** — apply § 13.1 if it's a shared types/IPC file
   - **Hook pattern** — apply § 13.2 if it's App.tsx

The current resolution table for Phase 1–6 lives in `docs/build-plan.html` (under Smoke Test).

### 13.6 Critical-path serialization

If Worker A's task depends on Worker B's commit, the dispatch prompt for Worker A includes:

```
## Wait for
- Worker B has pushed commit matching message regex "feat(.*): <thing>" within the last hour
- Verify with: git log --oneline | head -10
- If not yet present, STOP and report; Main will re-dispatch when B is ready.
```

No worker assumes another's deliverable is on `main`. They verify.

---

## 14. Side store integration points

The side store API (`apps/director/src/main/side-store.ts`) is implemented by
W3. It is the on-disk source of truth for session state: harness rules,
decisions, per-agent snapshots, and the transcript. Other workers call its
helpers at the moments below. Wiring happens at R3 review — Main does the
cross-cutting integration. This section is the contract those wirings target.

### Public surface (importable from `main/`)

```ts
import {
  initSession,
  registerSideStoreIpc,
  readWorldState,
  snapshotWorldState,
  appendHarnessRule,
  appendDecision,
  writeAgent,
  queueAgentWrite,
  flushAgentWrites,
  appendTranscript,
  setCurrentTask,
  setLastCanvas,
  clearLastCanvas,
  type WorldState,
  type Decision,
} from './side-store.js';
```

### Boot (W1 — `main/index.ts`)

Inside `app.whenReady()`, after the strip window is created:

```ts
await registerSideStoreIpc();    // boots session dir + exposes sidestore.snapshot
```

`initSession()` is idempotent — `registerSideStoreIpc()` calls it for you.

### Tool router (W1 — `main/tool-router.ts`)

- `handleUpdateHarness`: after `sendStripPatch('harness', ...)`, also:
  ```ts
  await appendHarnessRule(rule);
  await appendDecision({ at: Date.now(), kind: 'harness_rule', payload: { id: rule.id } });
  ```
- `handleDispatchAgentMock`: after the addAgent patch, persist + log:
  ```ts
  await writeAgent(agent);
  await appendDecision({ at: Date.now(), kind: 'agent_dispatched', payload: { agent_id: agent.id, task: agent.currentTask } });
  ```
- `handleRenderCanvas`: tag the world-state snapshot with the most recent
  surface so the planner can reason about it:
  ```ts
  setLastCanvas(args.component, args.props);
  ```

### Sim driver (W3 — `renderer/src/state/sim.ts`)

The sim lives in the renderer; it cannot directly call `side-store`. Instead it
fires an IPC `state.patch` event that main mirrors into the side store. The
simplest path is for main to subscribe to its own `state.patch` broadcasts and
call `queueAgentWrite(agent)` whenever an agent slice changes. This keeps the
sim renderer-only and the disk write co-located with FS.

### Planner (W1 — `main/planner.ts`)

Replace the stub:

```diff
- async function readWorldState(): Promise<Record<string, unknown>> {
-   // TODO(side-store): swap for `await readSideStore()` once W3 ships it.
-   return { active_agents: [], harness: [], recent_decisions: [], current_task: null };
- }
+ import { readWorldState } from './side-store.js';
```

`readWorldState()` is auto-initialising, so the planner does not need to call
`initSession()` itself.

### Realtime client (W2 — `renderer/src/realtime/*` + bridge)

On each `conversation.item.input_audio_transcription.completed` /
`response.output_audio_transcript.done` event, the renderer should emit a
patch to main so `appendTranscript(item)` runs. Same mechanism as agent
persistence — fire-and-forget IPC, main writes the JSONL line.

### Shutdown

Main calls `await flushAgentWrites()` from `app.on('before-quit', ...)` so any
pending debounced agent writes hit disk before the process exits.

### IPC channel

- `sidestore.snapshot` (invoke, renderer→main) — returns `{ ok: true, world } | { ok: false, error }`. Exposed for dev tooling and the rotation-reseed flow. Channel is `IpcChannel.SidestoreSnapshot` (`'sidestore.snapshot'`).

---

## Appendix A — Quick reference for hackathon-era code

Code already exists for most of § 2 + § 3. Pointers:

- `apps/director/src/shared/state.ts` — types from § 2
- `apps/director/src/shared/ipc.ts` — IpcChannel enum + payload types from § 3
- `apps/director/src/shared/realtime.ts` — DIRECTOR_INSTRUCTIONS persona + token types
- `apps/director/src/shared/canvas-ipc.ts` — canvas-specific channel constants
- `apps/director/src/main/tool-router.ts` — § 4 dispatch logic
- `apps/director/src/renderer/src/state/store.ts` — § 5 store
- `apps/director/src/renderer/src/state/sim.ts` — agent simulator (§ 7 escalation event source)

If any of these drift from this doc, the doc wins. File a contract-change commit and align the code.
