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

## Status

Hackathon build in progress. See [`docs/vision.md`](docs/vision.md) for the full product and UX specification.

## License

See [LICENSE](LICENSE).
