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
pnpm --filter director dev
```

The Strip appears as a 12×180 pill on the right edge of your primary display, breathing slowly. Press `⌘⇧Space` to summon.

## Status

Hackathon build in progress. See [`docs/vision.md`](docs/vision.md) for the full product and UX specification, [`docs/ux-design.md`](docs/ux-design.md) for the 7-pass design plan, and [`docs/build-plan.html`](docs/build-plan.html) for the live build dashboard.

## License

See [LICENSE](LICENSE).
