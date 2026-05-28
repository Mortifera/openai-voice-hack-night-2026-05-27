# Director — Internal Architecture

Compiled 2026-05-27 against `vision.md`, `ux-design.md` (Passes 1–5), and the four research docs (`gpt-realtime-2`, `genui-schema`, `genui-interaction-modes`, `compaction`). This document is opinionated. Where I had to make a call without a human in the loop, I made it and flagged the rest in section 11.

The architecturally load-bearing claim — the one every other decision in this doc descends from — is this: **the orchestrator's compacted memory is opaque and unreliable, so it cannot be the source of truth.** The source of truth is a structured side store on disk (`harness.json`, decisions ledger, per-agent snapshots, transcript), and every other layer — Realtime, orchestrator, Codex, UI — reads from and writes to it via typed tool calls. The orchestrator's Responses thread is *working memory*; the disk is *long memory*.

---

## 1. Process Model

Three processes, one of them spawning N children.

```
┌──────────────────────────────────────────────────────────────────────┐
│  ELECTRON MAIN PROCESS  (Node, headless)                             │
│  ────────────────────────────────────────────────────────────────    │
│  - Ephemeral token broker (mints Realtime client_secret)             │
│  - Orchestrator runner (gpt-5.5 Responses API, persistent thread)    │
│  - Side store writer (atomic writes to ~/.director/sessions/<id>/)   │
│  - Codex supervisor (spawns/manages Codex CLI subprocesses)          │
│  - Git worktree manager                                              │
│  - Tool dispatch hub (one place every tool call lands)               │
│  - Tray icon + global hotkey registration                            │
│  - IPC server (handlers for renderer commands; pushes events out)    │
└──────────────────────────────────────────────────────────────────────┘
        ▲                              ▲                              ▲
        │ typed IPC                    │ spawn/stdio                  │ HTTPS
        │ (electron contextBridge)     │                              │
        ▼                              ▼                              ▼
┌────────────────────────┐   ┌────────────────────┐    ┌──────────────────────┐
│ RENDERER  (React)      │   │ CODEX CLI × N      │    │ OPENAI API           │
│ ────────────────────── │   │ (in worktrees)     │    │ ──────────────────── │
│ - State Machine        │   │ - stdout JSON      │    │ - Realtime (WebRTC)  │
│ - Strip / Hive / Canvas│   │   stream parsed by │    │ - Responses (gpt-5.5)│
│ - WebRTC peer (Realtime│   │   supervisor       │    │ - Compaction         │
│   mic + audio + data ch│   │ - stderr surfaced  │    │                      │
│ - Audio output player  │   │   as agent log     │    │                      │
│ - Framer Motion        │   │                    │    │                      │
└────────────────────────┘   └────────────────────┘    └──────────────────────┘
```

### Electron main — responsibilities

- **Owns the OpenAI API key.** It never leaves the main process. The renderer asks the main process for an ephemeral Realtime token, never sees the long-lived key, and never speaks to the Responses API directly.
- **Owns the orchestrator.** `gpt-5.5` lives here, on a persistent Responses thread, with `store: false` + manual `previous_response_id` chaining (we manage state).
- **Owns the disk.** All writes to `~/.director/...` go through a single writer module with atomic-write semantics. No other process touches the side store.
- **Owns Codex.** Subprocess spawn, worktree create/teardown, stdout parsing, kill.
- **Routes tools.** When the Realtime layer (in the renderer) emits a `function_call`, the renderer forwards it to main; main dispatches to the right handler (orchestrator delegation, Harness write, Codex spawn, etc.) and returns a `function_call_output` back through IPC.
- **Heartbeats.** Watchdogs for Realtime session, Codex jobs, disk writer, and orchestrator timeouts.

### Renderer — responsibilities

- **Holds the State Machine** (Zustand store, see §2). Every UI surface is a pure read of this store.
- **WebRTC peer connection** to OpenAI Realtime, including the `oai-events` data channel. We do this in the renderer because WebRTC is browser-grade (echo cancellation, jitter buffer, native mic permissions) and Electron's renderer gives us all of it for free.
- **Plays audio out** of the Realtime track on a standard `<audio>` element + Web Audio API for the barge-in cut.
- **Renders Strip / Hive / Canvas / Tray peek.** Pure React + Framer Motion + Tailwind.
- **Handles global UI input**: hotkey events from main, mic state, Canvas click-to-resolve, keyboard cycling.

### Preload — responsibilities

- A thin `contextBridge`-exposed typed IPC surface. Renderer never touches `ipcRenderer` directly — it imports `window.director.*` from preload, which is fully typed (§7).
- The preload is the only file that calls `contextBridge.exposeInMainWorld('director', ...)`.

---

## 2. State Machine

**Library: Zustand**, with one store plus a small XState `interpret`'d machine wrapping the session-lifecycle subset (boot → connecting → live → rotating → degraded → quitting). Rationale: Zustand handles "lots of fields, frequent mutations from many places" beautifully, but the lifecycle has ~6 discrete macro-states with clear forbidden transitions, and XState catches those at compile time. Don't fight the tools — use both.

The State Machine lives in the renderer. The main process holds an **authoritative mirror** in memory (replicated via IPC events from the renderer when relevant *and* via direct writes when main is the actor). They reconcile every 250ms via a CRC heartbeat IPC; on mismatch, main wins and pushes a `state.sync` event.

### State shape

```ts
// apps/director/shared/state/types.ts
export interface DirectorState {
  session: {
    id: string;                          // session UUID
    startedAt: number;                   // epoch ms
    lifecycle: SessionLifecycle;         // 'boot' | 'connecting' | 'live' | 'rotating' | 'degraded' | 'quitting'
    realtime: {
      sessionId: string | null;          // OpenAI realtime session id
      connectedAt: number | null;
      rotationDueAt: number | null;      // startedAt + 55min
      transport: 'webrtc';
      micState: 'muted' | 'tap-open' | 'hold-open';
      vadActivity: 'silent' | 'speaking' | 'thinking' | 'speaking-back';
      voice: 'marin' | 'cedar';
    };
    orchestrator: {
      previousResponseId: string | null;
      lastCompactedAt: number | null;
      tokensSinceCompaction: number;     // estimated
      inFlightToolCalls: string[];       // call_ids awaiting function_call_output
    };
  };

  harness: HarnessSnapshot;              // mirrored from harness.json
  decisions: DecisionRecord[];           // mirrored from decisions.jsonl
  agents: Record<AgentId, AgentRuntime>; // ordered for UI by selector

  canvas: {
    state: 'hidden' | 'opening' | 'open' | 'awaiting-response' | 'dismissing';
    component: CanvasComponent | null;   // tagged union, one per genui-schema component
    componentId: string | null;
    queue: CanvasComponent[];            // race rule: queue >1 concurrent renders
  };

  transcript: TranscriptItem[];          // last ~200 items in memory; full on disk
  ui: {
    stripBounds: { x: number; y: number; w: number; h: number };
    stripMode: 'dormant' | 'listening' | 'speaking' | 'hive' | 'thinking' | 'blocked';
    hoveredAgentId: AgentId | null;
    canvasHandle: 'visible' | 'hidden';
  };
  errors: ErrorRecord[];                 // ring buffer, last 32
}

export interface AgentRuntime {
  id: AgentId;                           // 'maya' | 'jin' | 'cleo' | 'wren' | ...
  identity: AgentIdentity;               // name, role, accent, narrationTone (from Pass 4)
  status: 'spawning' | 'working' | 'blocked' | 'done' | 'error' | 'killed';
  currentTask: string | null;            // micro-text
  recentFiles: string[];                 // last 3
  blocker: string | null;
  worktreePath: string | null;
  pid: number | null;
  codexJobId: string | null;             // orchestrator's handle
  dispatchedAt: number;
  finishedAt: number | null;
  log: string[];                         // ring buffer, last 64 lines
}
```

### Mutation pattern

Zustand's `set((draft) => …)` with Immer middleware. Each writer goes through a **typed command function** in `state/commands.ts`, never raw `set` from a UI component:

```ts
// apps/director/renderer/state/commands.ts
export function agentStatusChanged(agentId: AgentId, status: AgentStatus, task?: string) {
  useStore.setState((s) => {
    const a = s.agents[agentId];
    if (!a) return;
    a.status = status;
    if (task) a.currentTask = task;
    if (status === 'blocked' || status === 'error') s.ui.stripMode = 'blocked';
  });
  ipcEmit('state.changed', { domain: 'agents', id: agentId });
}
```

### Who can write

| Writer | Domain it touches |
|---|---|
| Realtime tool handler (renderer → main → back) | `transcript`, triggers commands; never writes `harness` or `decisions` directly |
| Orchestrator response handler (main) | `agents`, `canvas`, `decisions`, `harness`, `transcript`, `orchestrator.*` |
| Codex supervisor (main) | `agents` (status, currentTask, recentFiles, log, finishedAt) |
| UI event handler (renderer) | `ui.*` only (hover, focus, mode peek) |
| Session lifecycle FSM (XState, renderer) | `session.lifecycle`, `session.realtime.*` |
| Disk hydrator on boot (main → renderer) | full state restore from `sessions/<id>/state.snapshot.json` |

Every write that crosses the renderer/main boundary goes through the IPC contract in §7. **No silent state mutation across process boundary.**

---

## 3. Side Store (the "World State")

The side store is the source of truth. The orchestrator's compacted context is *not*. Per the compaction research, decisions, Harness rules, and active job state are reconstructed from the disk store on every compaction-adjacent event and re-injected into the next Responses call as a system block.

### Directory layout

```
~/.director/
  harness.json                          # GLOBAL harness (user-level rules across projects)
  sessions/
    2026-05-27T18-23Z-mixtape/          # session id = ISO timestamp + project slug
      harness.json                      # PROJECT harness (merged with global at read time)
      decisions.jsonl                   # append-only decision ledger
      transcript.jsonl                  # append-only Realtime transcript stream
      agents/
        maya.json                       # per-agent state snapshot
        jin.json
        cleo.json
        wren.json
      orchestrator.jsonl                # append-only log of orchestrator response_ids + compaction events
      canvas.last.json                  # last rendered canvas (for restore)
      state.snapshot.json               # full DirectorState snapshot (debounced write)
      meta.json                         # project path, target app dir, created/updated, app version
      scratch/                          # ephemeral; cleared on quit
```

### File schemas (sketch)

```ts
// harness.json (session-scoped, deep-merged with global at read)
interface HarnessSnapshot {
  schemaVersion: 1;
  updatedAt: number;
  rules: HarnessRule[];                  // ordered, newest last
  agentIdentities: Record<AgentId, AgentIdentity>;
  projectMeta: { name: string; rootPath: string; stack: string[] };
  preferences: { voice: 'marin' | 'cedar'; theme: 'dark' };
}

interface HarnessRule {
  id: string;                            // ulid
  text: string;                          // "no gradients ever"
  addedAt: number;
  source: 'user-utterance' | 'inferred' | 'system';
  scope: 'global' | 'project' | 'task';
  expiresAt?: number;
}

// decisions.jsonl (one object per line)
interface DecisionRecord {
  id: string;                            // ulid
  at: number;
  kind: 'tool-routed' | 'aesthetic' | 'architectural' | 'harness-write' | 'escalation-resolved';
  text: string;                          // human-readable
  context?: Record<string, unknown>;     // structured metadata
  byAgent?: AgentId;                     // attribution if relevant
}

// agents/<id>.json (overwritten atomically; carries lifecycle state for resume)
interface AgentStateFile {
  schemaVersion: 1;
  runtime: AgentRuntime;
  history: Array<{ at: number; status: AgentStatus; task?: string }>;
  worktreeCommits: string[];             // sha refs created in this worktree
}

// transcript.jsonl (append-only; one line per Realtime conversation item)
interface TranscriptItem {
  at: number;
  realtimeSessionId: string;
  itemId: string;                        // openai item id
  role: 'user' | 'assistant' | 'system';
  phase?: 'commentary' | 'final_answer';
  content: TranscriptContent[];          // text, audio-transcript, function_call, function_call_output
  metadata?: { kind?: 'proactive_announcement' | 'world-state-brief' | ... };
}
```

### Read/write patterns

- **Append-only files** (`*.jsonl`): `O_APPEND` + `O_SYNC`, one line per record. Crash-safe for free.
- **Mutable files** (`harness.json`, `meta.json`, `state.snapshot.json`, `agents/<id>.json`): write to `*.tmp` in the same directory, `fsync`, `rename` over the original. This is atomic on macOS.
- **`state.snapshot.json` is debounced** at 1.5s. Every state mutation marks dirty; a single writer drains at most every 1.5s, plus a forced flush on `quit`, on Realtime rotation, and after every orchestrator response.
- **Schema versioning**: every file carries `schemaVersion: <int>`. The side-store reader has a migration function per schema; old sessions auto-migrate forward, never backward.

The side store is read by the orchestrator (to construct context blocks), by the World State Brief builder (to seed a new Realtime session), and on launch (to restore state).

---

## 4. Voice Layer (Realtime client)

### Where it lives

The WebRTC peer connection lives in the **renderer**. The renderer holds the SDP offer/answer dance with OpenAI directly using the ephemeral token. The data channel (`oai-events`) is the JSON event bus.

### Ephemeral token flow

```
1. Renderer →(IPC)→ Main:  director.realtime.requestToken(sessionConfig)
2. Main →(HTTPS)→ OpenAI:  POST /v1/realtime/client_secrets
3. OpenAI →(HTTPS)→ Main:  { client_secret: { value, expires_at } }
4. Main →(IPC)→ Renderer:  { token, expiresAt }
5. Renderer creates RTCPeerConnection, attaches mic + 'oai-events' data channel.
6. Renderer →(HTTPS)→ OpenAI:  POST /v1/realtime/calls (SDP offer)
7. OpenAI returns SDP answer → data channel opens.
```

The renderer never sees `OPENAI_API_KEY`. Tokens are short-lived.

### Tool routing

Realtime emits a `function_call` event on the data channel. The renderer:

1. Receives `response.function_call_arguments.done` + the matching `response.done` payload.
2. Emits IPC `realtime.toolCall` with `{ callId, name, args }`.
3. Main process **dispatch hub** routes by tool name (table below).
4. Main returns IPC `realtime.toolResult` with `{ callId, output, latencyMs }`.
5. Renderer pushes `conversation.item.create` (`function_call_output`) and `response.create` over the data channel.

Tool-routing table:

| Realtime tool | Handler | Notes |
|---|---|---|
| `consult_director` | Orchestrator handler (gpt-5.5) | Synchronous (long-running, blocks until Responses returns) |
| `dispatch_agent` | Orchestrator handler → Codex supervisor | Returns `{ job_id, status:'started' }` immediately; result arrives later via §8 proactive injection |
| `update_harness` | Harness writer (atomic) | Returns `{ ok: true, rule_id }` |
| `render_canvas` | State Machine (canvas slice) | Returns `{ ok: true, component_id }`; response value arrives later as a separate `canvas_response` tool call |
| `dismiss_canvas` | State Machine | Returns `{ ok: true }` |
| `record_decision` | Decisions writer (append-only) | Returns `{ ok: true, decision_id }` |
| `ask_user` | (passthrough; Realtime asks the user directly) | No backend hit; just the Realtime layer prompting |
| `read_world_state` | Side-store reader | Returns Harness rules + active agents + last canvas. Used pre-rotation. |

### Session rotation protocol

Triggered by the lifecycle FSM at T+55min (or when the orchestrator explicitly requests rotation).

1. **(T+55:00)** FSM moves `session.lifecycle: 'rotating'`. Renderer notes "rotation queued".
2. **Main constructs the World State Brief** from the side store:
   - Active Harness rules verbatim (from `harness.json`).
   - Active agents + statuses (from in-memory mirror, cross-checked against `agents/*.json`).
   - Current goal (top-of-prompt block from orchestrator's last system inject).
   - Last canvas state (from `canvas.last.json`).
   - Last 6 transcript items (from in-memory tail of `transcript.jsonl`).
   - Time elapsed.
3. **Main mints `Session_B`** via `/v1/realtime/client_secrets`. Pass full `session.update` (model, voice, instructions, tools — *identical to Session_A* so prompt caching survives).
4. Main → Renderer: `realtime.rotationReady` with token + brief.
5. Renderer opens `Session_B` over a *second* `RTCPeerConnection`. Once data channel is open:
   - Send `conversation.item.create` with the Brief as a `system` role item.
   - Wait for `conversation.item.created` ack.
6. **Renderer watches the audio output** for a planned ~200ms silence window (or immediate, if VAD is `silent`).
7. **At silence**: swap `<audio>` srcObject from `Session_A` to `Session_B`. Mute `Session_A` mic track; route mic to `Session_B`.
8. Send `Session_A` a graceful close; tear down peer connection.
9. FSM → `'live'`. Append `rotation.complete` to `orchestrator.jsonl`.

If rotation **fails**, fall back to running `Session_A` until the 60min cap. At T+59:30, surface a soft notification: "session reset coming". At T+60:00, force a cold rotation (audible silence ~1s) and degrade gracefully.

---

## 5. Orchestrator Layer (gpt-5.5)

### Where it lives

Main process, single module (`apps/director/main/orchestrator/`). One long-lived "thread" implemented as a chain of `responses.create` calls with `previous_response_id` linking. We use `store: false` and `previous_response_id` so OpenAI doesn't persist on their side; we manage state.

Actually — and this is the call I'm making — we use **manual `input`-array chaining** for the first turn, then switch to `previous_response_id` chaining after the first `responses.compact`. Reason: the compaction blob returned by `responses.compact` is `output` items we need to *prepend* to the next `input` array; once the chain is established, `previous_response_id` saves bandwidth on subsequent turns. We keep an on-disk record of the chain (`orchestrator.jsonl`) so we can rebuild from any point on recovery.

### Reaching the orchestrator from Realtime

The Realtime layer's `consult_director` tool is the bridge. Realtime calls `consult_director({ query, mode })`. The dispatch hub routes it to `orchestrator.consult(query, mode)`:

```ts
// apps/director/main/orchestrator/consult.ts
export async function consult(query: string, mode: 'quick' | 'deep'): Promise<string> {
  const turn = await buildOrchestratorInput({
    userMessage: query,
    forceSystemReinjection: shouldReinject(),  // true after compaction
  });
  const resp = await openai.responses.create({
    model: 'gpt-5.5',
    previous_response_id: state.session.orchestrator.previousResponseId,
    input: turn.input,
    instructions: turn.instructions,           // Harness rules go here
    store: false,
    context_management: [{ type: 'compaction', compact_threshold: 180000 }],
    tools: ORCHESTRATOR_TOOLS,
  });
  await persistResponse(resp);                 // append to orchestrator.jsonl
  return extractFinalAnswer(resp);             // returned to Realtime as function_call_output
}
```

### Orchestrator tool dispatch

`gpt-5.5` calls tools by name. Each tool resolves in main process:

| Orchestrator tool | Handler | Side-effect |
|---|---|---|
| `dispatch_agent({ agent_id, task, files })` | Codex supervisor | Spawns Codex in worktree; returns `{ job_id, status }` |
| `update_harness({ rule })` | Harness writer | Appends rule, atomic-writes `harness.json`, mirrors to state |
| `render_canvas({ component, props })` | State Machine | Pushes to `canvas.queue` (or replaces if idle) |
| `record_decision({ text, kind })` | Decisions writer | Appends to `decisions.jsonl` |
| `list_active_jobs()` | Side-store reader | Returns active Codex jobs from `agents/*.json` |
| `read_decisions({ since })` | Side-store reader | Returns decisions since timestamp |
| `set_current_goal({ text })` | Goal slice writer | Updates a single string in `meta.json` |
| `force_compaction()` | Compaction runner | Calls `responses.compact(...)` and updates chain |
| `consult_realtime({ utterance })` | Dispatch back to Realtime as proactive announcement | See §8 of realtime research |

### Compaction strategy

Per the compaction research, hybrid:

- Pass `context_management: [{ type: 'compaction', compact_threshold: 180000 }]` on **every** `responses.create` (safety net).
- Manually call `responses.compact(...)` at quiescent moments:
  - After any tool-call batch whose cumulative output > 50k tokens.
  - On user idle ≥ 90s with token count > 80k.
  - Before every Realtime session rotation (precondition).
- After every compaction, run a **health-check probe**: synthetic single-turn `responses.create` asking "what is the current goal, active jobs, and most recent user instruction?" and compare against side store. On mismatch, re-inject must-preserve blocks as a fresh system message.

### Long history preservation

Compaction is lossy. The orchestrator **must not** rely on its own context to recall load-bearing facts. Three durable surfaces:

1. **`instructions` field** — Harness rules + active agent table + current goal — rebuilt from side store on every `responses.create`. Never compacted (instructions live outside the items array).
2. **Decision ledger** — readable via `read_decisions` tool.
3. **Recent transcript** — last 6 items kept verbatim by re-injection as a `user`-role message containing a structured "Recent context" block on the turn immediately after each compaction.

---

## 6. Codex Sub-agent Supervisor

### Spawn protocol

1. Orchestrator calls `dispatch_agent({ agent_id: 'maya', task: 'wire the flip animation', files: [...] })`.
2. Supervisor allocates a worktree:
   - `git worktree add ../<project>-wt-maya-<ulid> -b agent/maya/<ulid>` off the current HEAD.
   - Records the path in `agents/maya.json:worktreePath`.
3. Supervisor seeds the system prompt by reading `harness.json:agentIdentities.maya` (the agent identity from Pass 4) plus the Harness rules.
4. Supervisor spawns: `codex --task-file <tmpfile> --workdir <worktree> --output json-stream` (exact CLI flags TBD against Codex 2026 docs; assume JSON-stream output exists or wrap with our own line parser).
5. Records `pid`, `codexJobId`, `spawning` status.
6. Returns `{ job_id, status: 'started' }` to the orchestrator immediately.
7. Orchestrator's tool result feeds the Realtime layer via the normal function_call_output path.

### Status reporting

Codex stdout is parsed line-by-line as either:
- **Structured event** (JSON line) — `{ event: 'tool_call' | 'file_write' | 'task_progress' | 'blocked' | 'done', ... }`.
- **Free text** — appended to the agent log ring buffer.

Each structured event maps to a State Machine command:

| Codex event | Command |
|---|---|
| `task_progress` | `agentStatusChanged(id, 'working', currentTask)` |
| `file_write` | `agentFileTouched(id, path)` |
| `blocked` | `agentBlocked(id, blockerText)` → triggers proactive escalation (§8 realtime) |
| `done` | `agentDone(id)` → orchestrator notified via synthetic `function_call_output` |
| `error` | `agentError(id, errorText)` → triggers escalation |

### Kill / interrupt / shutdown

- **Soft kill** (`agentKillRequested(id)`): supervisor sends SIGTERM, waits 5s, then SIGKILL.
- **Hard interrupt** (user says "stop"): supervisor sends SIGINT, expects Codex to finish current step and exit. On 3s timeout escalate to SIGKILL.
- **Graceful shutdown** on app quit: SIGTERM all running Codex processes in parallel, wait up to 5s, then SIGKILL stragglers. State is flushed before processes are reaped.

### Worktree cleanup

- On `done` + orchestrator decides to merge: `git worktree remove ...` after the commit lands on the integration branch.
- On `error` or `killed`: leave worktree on disk under `~/.director/abandoned/<timestamp>-<agent>/` for forensic review. Cleared on next launch with a confirmation prompt if > 7 days old.

### Concurrency

Target: **4 agents in parallel** (matches Pass 1 Hive cap). Pool implemented as a `p-limit`-style semaphore with `max: 4`. Spawn requests beyond 4 are queued; orchestrator is told the agent is in `spawning` status with a `queue_depth` field.

---

## 7. IPC Contracts

Single typed surface in `apps/director/shared/ipc/contract.ts`. The preload script re-exports a typed wrapper.

```ts
// apps/director/shared/ipc/contract.ts

// Commands: renderer → main, expect a typed reply (Promise).
export interface DirectorCommands {
  'realtime.requestToken': (cfg: RealtimeSessionConfig) => Promise<{ token: string; expiresAt: number }>;
  'realtime.toolCall': (call: { callId: string; name: string; args: unknown }) =>
                          Promise<{ output: unknown; latencyMs: number; ok: true } | { ok: false; error: string }>;
  'realtime.transcriptItem': (item: TranscriptItem) => Promise<void>;             // fire-and-forget but awaitable
  'state.snapshotRequest': () => Promise<DirectorState>;
  'state.commit': (patch: StatePatch) => Promise<void>;                            // narrow patches only
  'session.rotate': () => Promise<{ ok: true; brief: WorldStateBrief }>;
  'session.resume': (sessionId: string) => Promise<DirectorState>;
  'session.startFresh': (projectPath?: string) => Promise<DirectorState>;
  'orchestrator.consult': (q: { query: string; mode: 'quick' | 'deep' }) => Promise<{ answer: string }>;
  'app.quit': () => Promise<void>;
}

// Events: main → renderer, broadcast.
export interface DirectorEvents {
  'agent.statusChanged': { agentId: AgentId; status: AgentStatus; task?: string };
  'agent.fileTouched':   { agentId: AgentId; path: string };
  'agent.blocked':       { agentId: AgentId; blocker: string };
  'agent.done':          { agentId: AgentId; summary: string };
  'agent.error':         { agentId: AgentId; error: string };
  'harness.updated':     { rule: HarnessRule };
  'decisions.appended':  { record: DecisionRecord };
  'canvas.requested':    { component: CanvasComponent; componentId: string };
  'canvas.dismissed':    { componentId: string };
  'orchestrator.proactiveAnnouncement': { text: string; reason: string; metadata?: Record<string, unknown> };
  'session.lifecycleChanged': { lifecycle: SessionLifecycle };
  'session.rotationReady':    { token: string; expiresAt: number; brief: WorldStateBrief };
  'state.sync':          { state: DirectorState };   // reconciliation push
  'error.surfaced':      { id: string; kind: string; message: string; severity: 'info' | 'warn' | 'error' };
}
```

The preload exposes `window.director` with typed `invoke<C extends keyof DirectorCommands>(channel, args)` and `on<E extends keyof DirectorEvents>(event, handler)`.

### Main ↔ Codex subprocess protocol

Stdin: closed (we feed task via `--task-file`). Stdout: JSON-lines structured events as above. Stderr: free-text, surfaced to agent log. SIGUSR1: reserved for "pause" (orchestrator wants to interject); SIGTERM/SIGINT/SIGKILL as above.

---

## 8. Persistence + Recovery

### What gets written when

| File | Writer | Cadence |
|---|---|---|
| `harness.json` | Harness writer | On every `update_harness` (atomic) |
| `decisions.jsonl` | Decisions writer | Append on every `record_decision` (sync) |
| `transcript.jsonl` | Transcript writer | Append per Realtime conversation item (sync) |
| `agents/<id>.json` | Codex supervisor | On every status transition (atomic) |
| `orchestrator.jsonl` | Orchestrator runner | Append after every `responses.create` and `responses.compact` (sync) |
| `canvas.last.json` | State Machine listener | Debounced 500ms after canvas state changes (atomic) |
| `state.snapshot.json` | Main-mirror writer | Debounced 1.5s; force-flush on quit/rotation |
| `meta.json` | Goal writer | On goal change (atomic) |

### Quit semantics

`app.quit` IPC →
1. Main signals all Codex children (SIGTERM, 5s grace).
2. Flush state.snapshot.json immediately (no debounce).
3. Send `realtime.disconnect` to renderer; renderer closes peer connection.
4. Force-flush all open append streams; `fsync`.
5. Append `{ at, kind: 'session.closed' }` to `orchestrator.jsonl`.
6. Electron quit.

If killed hard (crash, SIGKILL): append-only files survive (each line is independently valid JSON). `state.snapshot.json` may be stale by up to 1.5s; on next launch, replay the tail of `transcript.jsonl` + `decisions.jsonl` + `agents/*.json` to rebuild missing state. Worktrees on disk are matched against `agents/*.json:worktreePath`; orphans get archived.

### Resume protocol (matches Pass 3 — 3C-1)

On launch, main process:
1. Reads `~/.director/sessions/*` directory, finds most recent by `meta.updated`.
2. If found and < 7 days old: emit `session.lifecycleChanged: 'boot'` with a `resumeAvailable: true` flag, pre-load snapshot into renderer.
3. Renderer shows Strip, then Director speaks: "Pick up Mixtape, or start fresh?" Canvas slides out with 2-option picker.
4. **User says "Resume"**: main hydrates Harness, transcript context, current goal, decisions ledger into orchestrator's first `responses.create` instructions+input. Active agents do NOT auto-respawn (per Pass 3).
5. **User says "Start fresh"**: main creates a new session directory; old session stays on disk for later resume.

---

## 9. Error Handling + Degradation

| Failure | Detection | Degradation path |
|---|---|---|
| **Realtime disconnect (transient)** | Data channel close + WebRTC iceConnectionState transitions | FSM → `'degraded'`. UI: Strip dims grey + tray red dot. First 30s: silent retry with exponential backoff (1s, 2s, 5s, 10s). After 30s: single macOS notification "Director offline — reconnecting". Mic muted; queued utterances replay on reconnect. |
| **Realtime disconnect (hard, 3 retries fail)** | Retry budget exhausted | FSM → `'degraded'` persistent. macOS notification. Orchestrator can still run (text mode) for resume on reconnect. |
| **Orchestrator timeout** | `responses.create` exceeds 60s | Cancel request; emit `error.surfaced` (severity warn); Realtime says "lost my train of thought — try again". Side store unaffected. Next `consult_director` retries with the same input. |
| **Orchestrator API 5xx** | Network/API error | Exponential retry up to 3x. On final fail, surface error + offer Director a `--text-fallback` mode. |
| **Codex crash** | Subprocess exit code ≠ 0 or unparseable stdout | Mark agent `error`, surface blocker text from stderr tail, notify orchestrator via proactive injection. Worktree archived. Orchestrator decides whether to retry. |
| **Codex hang (no output > 60s)** | Watchdog | Soft escalation: orchestrator narrates "Maya seems stuck". User can say "kill it" or "give it more time". |
| **Disk write failure** | `fs.write` throws (`ENOSPC`, perm) | In-memory state continues; warn user via macOS notification "Director cannot save to disk". Append-only files retry with backoff. If sustained, FSM → `'degraded'` and notify on every state change. |
| **API key missing / invalid** | Token endpoint returns 401 | Boot stops at "connecting"; Canvas opens with `form` component asking for the key (per Pass 2 mic-denial pattern); on submit, save to macOS keychain (NOT plaintext .env), retry. |
| **Mic permission denied** | `getUserMedia` rejects | Canvas opens with permission card + System Settings deeplink (per Pass 2). |
| **Session rotation fails** | New session 5xx or SDP timeout | Stay on current session; warn user pre-cap; force cold rotation at T+60 with ~1s audible silence. |
| **Canvas render exception** | React error boundary | Compact error card in Canvas + voice apology "couldn't draw that". Logged to `errors` ring buffer. |

---

## 10. Module / File Layout

```
apps/director/
  package.json
  electron-vite.config.ts                # we use electron-vite (see §11)
  tsconfig.json

  main/                                  # Electron main process
    index.ts                             # entry: createWindow + tray + IPC server
    ipc/
      server.ts                          # registers all DirectorCommands handlers
      typed.ts                           # type wrapper around ipcMain
    realtime/
      tokenBroker.ts                     # POST /v1/realtime/client_secrets
      rotationCoordinator.ts             # builds World State Brief, mints Session_B
    orchestrator/
      index.ts                           # entrypoint: consult(), dispatch handlers
      buildInput.ts                      # constructs input array + instructions
      compactionRunner.ts                # responses.compact wrapper + health check
      tools/                             # one file per orchestrator tool
        dispatchAgent.ts
        updateHarness.ts
        renderCanvas.ts
        recordDecision.ts
        ...
    codex/
      supervisor.ts                      # spawn pool, kill, queue
      worktreeManager.ts                 # git worktree add/remove
      stdoutParser.ts                    # JSON-lines → events
      identitySeeder.ts                  # builds system prompt from harness.agentIdentities
    sideStore/
      paths.ts                           # ~/.director resolution
      writer.ts                          # atomic write + append-only helpers
      reader.ts                          # hydration helpers, schema migrations
      schemas/
        harness.ts
        decisions.ts
        transcript.ts
        agent.ts
        orchestrator.ts
    tray/
      icon.ts
      menu.ts
    hotkeys/
      register.ts                        # global ⌘⇧Space
    keychain/
      apiKey.ts                          # keytar wrapper

  renderer/                              # React app
    index.html
    main.tsx
    state/
      store.ts                           # Zustand root
      lifecycleMachine.ts                # XState session lifecycle
      commands.ts                        # all typed setters
      selectors.ts                       # hooks: useAgents, useCanvas, useStrip
      ipcSync.ts                         # subscribes to DirectorEvents → commands
    realtime/
      peer.ts                            # RTCPeerConnection setup
      dataChannel.ts                     # parses oai-events
      audioOut.ts                        # cancellable audio sink
      toolBridge.ts                      # forwards function_call to main, returns output
      rotationClient.ts                  # second peer setup during rotation
    ui/
      Strip/
        index.tsx
        Waveform.tsx
        Hive.tsx
        AgentNode.tsx
      Canvas/
        Panel.tsx
        components/                      # one file per genui-schema component
          Moodboard.tsx
          OptionsPicker.tsx
          ProseOptions.tsx
          CopyVariants.tsx
          DecisionBrief.tsx
          CodePreview.tsx
          Diagram.tsx
          Form.tsx
          AgentPod.tsx
          ArtifactPreview.tsx
          HtmlEscape.tsx
        voiceResolution.ts               # canvas_highlight animation orchestrator
      tokens/                            # extracted from Pass 5 design system
        colors.ts
        motion.ts
        spacing.ts
        typography.ts

  preload/
    index.ts                             # contextBridge.exposeInMainWorld('director', ...)

  shared/
    ipc/
      contract.ts                        # DirectorCommands + DirectorEvents types
    state/
      types.ts                           # DirectorState + sub-interfaces
    domain/
      agent.ts                           # AgentIdentity, AgentStatus
      harness.ts                         # HarnessRule, HarnessSnapshot
      canvas.ts                          # CanvasComponent tagged union
      decision.ts
      transcript.ts
    util/
      ulid.ts
      atomicJson.ts                      # shared atomic write helper (also used by tests)

  test/                                  # vitest
    sideStore.spec.ts
    rotation.spec.ts
    compaction.spec.ts
    codexParser.spec.ts
```

---

## 11. Open Architecture Decisions

Things I made a call on (and the reasoning), and things that genuinely need a human:

### Calls I made

- **Zustand + XState (not pure XState)**. Zustand for the fast-mutating field store; XState specifically for `session.lifecycle`. Pure XState would over-formalize hover state and ring buffers; pure Zustand would let illegal lifecycle transitions slip through.
- **electron-vite (not electron-forge)**. Faster HMR, cleaner Vite-native dev experience, simpler main/preload/renderer separation. Forge is heavier and oriented toward packaging — we'll add `electron-builder` for the final dmg.
- **WebRTC in renderer, no parallel WebSocket in main**. The realtime research suggested main *could* hold its own socket; I'm punting that. Main injects context by sending IPC events to the renderer, which forwards over the same data channel. Simpler, one connection, fewer race conditions. We pay a tiny IPC hop on proactive announcements; that's fine.
- **`store: false` on Responses + manual chaining**. We're managing state ourselves; no reason to pay for OpenAI's storage and no reason to lock into their conversation model.
- **Codex CLI subprocess (not in-process SDK)**. Subprocess isolation = crash containment + worktree isolation + clean kill. Worth the IPC parsing tax.
- **Side store at `~/.director/` not in-project**. Director is the user's tool, not a per-repo dependency. Project-specific harness lives in the session dir; global harness travels with the user.
- **API key in macOS keychain via `keytar`**. Plaintext `.env` is hackathon-acceptable but keychain is two extra hours of work and infinitely better demo posture.
- **Atomic writes via tmp+rename**. Standard. No need for SQLite or a real DB for v1.

### Genuinely open (need a human call)

1. **Codex CLI flag surface.** I assumed `codex --task-file <f> --workdir <d> --output json-stream` exists and emits structured events. The "Codex for almost everything" research is pending. If the real CLI is conversational/REPL-style, the supervisor's stdout parser needs a rewrite and we may need a wrapper script.
2. **Do we ship a local HTTP server (e.g. for browser-side debug, external MCP servers, or a hypothetical "observer" second-screen mode)?** I said no for v1 to keep the surface tight. Worth confirming.
3. **macOS keychain vs `.env` for hackathon demo.** Keychain is right; `.env` is faster. Pick which battle to fight on Friday.
4. **Voice choice: `marin` vs `cedar`.** Pick before demo day; harness sets it on session creation.
5. **Reasoning effort defaults.** I assumed `low` on Realtime (reflex routing) and let `gpt-5.5` use its default (medium-ish) on the orchestrator. If `xhigh` orchestrator turns become the demo's "aha" moment, revisit.
6. **MCP servers directly on Realtime?** I kept all heavy tools behind `gpt-5.5`. The realtime research notes you *can* expose MCP directly — would let trivial reads (file open, git status) skip the orchestrator entirely. Tempting for a v2 demo, risky for v1.
7. **Canvas render-vs-update.** I went with full re-render on prop change (simpler). Patching live components is smoother but adds a tool surface (`update_canvas`).
8. **Per-session Harness vs project Harness.** I implemented both (deep merge at read time). Could simplify to project-only for v1.
9. **Compaction model.** I default to `gpt-5.5` for compaction (matches orchestrator model). Using a cheaper model could save money but risks blob/decoder mismatch — needs testing.
10. **Schema migrations.** I built in `schemaVersion` everywhere but haven't written any migrators. They become real the first time we bump.
11. **Worktree base branch.** I assume `git worktree add ... -b agent/<name>/<ulid>` off current HEAD. If the user is on a feature branch with uncommitted changes, this fails — need a pre-flight check + a "stash or commit?" prompt via Canvas form.
12. **Where does Codex hand back diffs?** I assumed the worktree contains the changes and the orchestrator decides when to merge to the user's branch. Need to spec: does Director auto-merge on `done`, ask via Canvas, or always require explicit user say-so?

---

### Closing note

Every architectural decision in this doc ladders back to the compaction finding: the orchestrator's memory is opaque, so the disk is the truth, so every other layer reads from and writes to the disk through typed tool calls. If that single principle holds, the rest of the system is just plumbing.
