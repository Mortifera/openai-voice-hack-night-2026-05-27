# Director

> An ambient voice orchestration layer for attended parallelization. Built for the OpenAI Voice Agents hackathon, May 2026.

## What it is

Director is not a chatbot. It is not a copilot. It is the **manager's chair** for a fleet of coding agents.

You speak architectural intent. A pod of specialized sub-agents executes asynchronously in the background — frontend, backend, database, in parallel. The UI lives at the edge of your screen as a glassy ambient strip, expanding into an agent hive when work is in flight and into a GenUI canvas when you need to render a visual judgment.

When the system hits a subjective fork or a fatal blocker, it **proactively interrupts you by voice** — calm, concise, no filler. You answer; execution continues. When you interrupt the system, it stops mid-sentence and adopts your correction. If the correction is a rule ("no gradients, ever"), it gets written to the project's **Harness** — a living memory that binds every future agent in the fleet.

## The shift

| Old model | Director |
|---|---|
| You type a prompt, wait synchronously, copy-paste the output. | You speak intent. Agents execute in parallel. You approve artifacts. |
| The AI is a worker waiting for instructions. | The AI is a router that summons workers and reports back. |
| The UI is a chat window. | The UI is an ambient strip that expands only when needed. |
| Corrections live in your head until you re-type them. | Corrections write themselves into the Harness, binding every future run. |

## The three UI states

1. **The Ambient Strip** — a slim glass bar at the edge of the screen, idle, listening.
2. **The Agent Hive** — vertical nodes per sub-agent, each with a spinning ring and fading micro-task text trailing beneath.
3. **The GenUI Canvas** — a frosted panel that slides out for moodboards, diagrams, and live-rendered components you can click and inspect before any PR exists.

## The two pillars

- **The Harness.** Architectural rules, mistakes, and aesthetic preferences accumulate automatically. Correct once, enforced everywhere.
- **Proactive orchestration.** The system runs until it hits a judgment call or a wall, then escalates by voice. You stay free until you're genuinely needed.

## Architecture in one paragraph

Voice, visuals, and execution are decoupled. A **Voice Orchestrator** routes spoken intent into commands against a **Central State Machine**. Sub-agents run in a sandboxed async environment, reading the plan, writing files, running tests — and reporting status back to the State Machine. The UI reflects the State Machine; it never talks to agents directly. The GenUI Canvas accepts raw HTML / Mermaid / image strings from the State Machine, so the same interface fluidly becomes a moodboard, a diagram, or a live React app.

## Running locally

### Prerequisites
- macOS (overlay relies on `NSVisualEffectView` vibrancy)
- Node 22+, pnpm 10+
- An **OpenAI API key** with Realtime API access (`gpt-realtime-2`) and Images API (`gpt-image-1`)

### One-time setup

```bash
pnpm install
```

### API keys

Director needs an OpenAI API key in `.env` at the **repo root** (never in `apps/director/`, never committed):

```bash
# .env (at repo root — gitignored)
OPENAI_API_KEY=sk-proj-...
```

The main Electron process loads this via `dotenv` and mints short-lived ephemeral Realtime tokens for the renderer — the raw key never reaches the browser context.

Order of precedence (first match wins):
1. `./.env` (repo root) — primary
2. `apps/director/.env` (per-app override) — fallback

To verify:
```bash
cd apps/director && node -e "require('dotenv').config({path:'../../.env'});console.log(process.env.OPENAI_API_KEY?.slice(0,12))"
```

### Run

```bash
# 1. Director (chat window + Realtime + state + canvas)
pnpm --filter director dev

# 2. Mixtape demo target (Director's "what we're building" app)
pnpm --filter mixtape dev
```

Director opens as a 480×720 chat window. Mixtape serves at `http://localhost:3001`.

## Hackathon scorecard — what shipped in 5 hours

> **Hackathon window**: 2026-05-27 from ~16:00 to 18:30 PDT (~5 hours design + build). No submission was made; project continued past the window.

### ✅ Shipped during the hackathon

**Design + research** (full 7-pass design review + load-bearing technical research):
- `docs/vision.md` — product DNA, persona, three-state UI anatomy
- `docs/ux-design.md` — 7-pass design plan (info arch, states, journey, anti-slop, design system, a11y, decisions)
- `docs/architecture.md` — internal system architecture (process model, state machine, IPC, side store)
- `docs/demo-timeline.md` — beat-by-beat Mixtape demo script
- `docs/research/`: GPT-realtime-2 capabilities, compaction strategy, Codex SDK, GenUI schema (×2), demo target
- `design.pen` — 13 Pencil mockups (Strip dormant/listening/thinking/hive×3, Canvas moodboard/options/code/form/artifact/harness, desktop hero)

**Engineering scaffolding**:
- Monorepo (pnpm workspaces) with `apps/director` (Electron + Vite + React 19 + Tailwind v4 + Framer Motion + Zustand) and `examples/mixtape` (Next.js 15)
- Director Electron app: token mint endpoint, Realtime WebRTC client, persona-driven session config, four registered tools (`render_canvas`, `dispatch_agent_mock`, `ask_user`, `update_harness`), tool router (main process), Zustand state machine + canonical store + selectors, IPC contracts, semantic-VAD-driven turn detection
- Strip UI components for all six states (dormant, listening, speaking, thinking, hive, escalating)
- Second BrowserWindow for the Canvas with three React components: Moodboard, ArtifactPreview, HarnessRuleSave; iframe support for live Mixtape embedding
- Agent simulator (`startMixtapeDemo`) that drives 4 named agents (Maya / Jin / Cleo / Wren) through the canonical demo timeline including the Jin-blocks-on-Stripe-key escalation moment; renderer-side `director:escalation` CustomEvent wired to Realtime server-initiated speech
- Mixtape demo target: working at localhost:3001 with cassette aesthetic (flippable card, abstract cover art generator, hover-waveform tracks, vibe-driven auto-generate via `?vibe=` URL param)

### 🟡 Built but not integrated (state at end of hackathon window)

The Electron renderer's `window.director` preload bridge **was not surfacing in the renderer** at the deadline — `bridge missing (non-Electron context?)` thrown from `RealtimeClient.connect()`. Net effect: every subsystem worked in isolation (verified individually), but the chat UI's voice + tool-call path never round-tripped end-to-end. Time was lost on:
- Visual fixes for traffic-light + transparent-bg issues on the original overlay strip design
- Global hotkey conflicts (Cmd+Shift+3-6 are macOS screenshot keys; later Cmd+Opt+M is window-minimize) — finally settled on Hyper chord `⌃⌥⌘ + key`
- A late pivot from the floating-overlay strip to a normal 480×720 chat window (the right call, taken too late)

### ⏳ Post-hackathon roadmap

In priority order:

1. **Fix the preload bridge** so `window.director` exposes correctly in the renderer. Diagnose `process.contextIsolated` and the preload load path in dev mode under `electron-vite`.
2. **End-to-end smoke test**: ⌘⇧Space → mic → "build Mixtape" → Director routes `dispatch_agent_mock` × 4 → Hive populates → Jin blocks → Director escalates by voice → user resolves → reveal Canvas with the live Mixtape iframe.
3. **Wire the gpt-5.5 planner tier**. Today Realtime acts as Director directly. The full architecture has a `consult_director` tool that hops to gpt-5.5 (long-context planner) and streams reasoning back to Realtime as audio narration. This is the third tier of the system.
4. **Replace the agent simulator with real Codex CLI subprocesses** per `docs/research/codex-for-everything.md` — git worktrees, AGENTS.md per-agent personas, structured JSONL event stream.
5. **Session rotation** (gpt-realtime-2 has a 60-min cap) with World State Brief injection on the new session — already specced in `docs/ux-design.md` Pass 2.
6. **Compaction strategy** for the gpt-5.5 orchestrator per `docs/research/compaction.md` — side store is source of truth, opaque blob is backup.
7. **Phase 2 from `TODOS.md`**: live captions, conversational onboarding, Söhne font swap, Windows/Linux ports, always-listening wake word, pair mode.

### What was tried in the last 90 minutes (after the hackathon window)

A live pivot from the floating overlay to a chat window. Three parallel agents shipped:
- Agent A — Convert main process to normal chat window (c78625f)
- Agent B — Rewrite App.tsx as chat UI (0a00bed)
- Agent C — Wire iframe Mixtape into ArtifactPreview (fa914a7)

All three compiled and the chat UI rendered cleanly, but the preload-bridge bug surfaced once we tried the first end-to-end click. Investigation paused here.

## Documentation index

- [`docs/vision.md`](docs/vision.md) — product vision
- [`docs/ux-design.md`](docs/ux-design.md) — 7-pass design plan
- [`docs/architecture.md`](docs/architecture.md) — system architecture
- [`docs/demo-timeline.md`](docs/demo-timeline.md) — beat-by-beat demo script
- [`docs/build-plan.html`](docs/build-plan.html) — Gantt + dispatch units + checkpoints
- [`docs/research/`](docs/research/) — GPT-realtime-2, compaction, Codex, GenUI, Mixtape
- [`TODOS.md`](TODOS.md) — phase 2 + 3 backlog

## License

See [LICENSE](LICENSE).
