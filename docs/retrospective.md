# Hackathon Retrospective

> Window: 2026-05-27, ~16:00 → 18:30 PDT (~5 hours). Submission was not made; project continues.

## What landed

- **Design**: 7-pass UX review (`docs/ux-design.md`), architecture spec (`docs/architecture.md`), demo timeline (`docs/demo-timeline.md`), 13 Pencil mockups (`design.pen`), 7 deep research docs (`docs/research/`).
- **Engineering**: Electron + React + Tailwind + Zustand scaffold, Realtime voice client (WebRTC + tool routing), six Strip UI states, second BrowserWindow Canvas with three GenUI components, AI image generation for moodboard/cover assets, agent simulator driving the canonical Mixtape timeline, working Mixtape app at `localhost:3001`.

## What broke at the boundary

Every subsystem worked in isolation (verified individually by each worker). The integration boundary — specifically the renderer's `window.director` preload bridge — failed to surface. Result: chat UI rendered, hotkeys registered, mic permission was granted, but `RealtimeClient.connect()` threw immediately on `bridge missing`. No subsystem was "wrong"; the integration was never end-to-end tested before the visual demo.

## What we got wrong about agent coordination

### 1. Prompts had shallow context

Workers read what we *named* in the prompt, not what we *meant*. When we wrote "read `docs/ux-design.md` Pass 5," they did. When we wrote "match Pencil's Strip / Dormant," they did. When we omitted "verify `window.director` is reachable from the renderer console after your change," they didn't. **Prompts encode the threshold for acceptance, and we kept setting it at the unit boundary instead of the integration boundary.**

### 2. We didn't enumerate forbidden patterns

Agent W4 chose `Cmd+Shift+4/5/6` as Canvas dev shortcuts — these are macOS native screenshot keys. I never told them to avoid macOS-reserved chords. Same again with `Cmd+Opt+M` (window minimize). Eventually settled on Hyper (`Ctrl+Alt+Cmd`+key) which is unbound by default. A `## Forbidden shortcuts` line in the very first prompt would have saved 15 minutes.

### 3. We let two stores coexist

W2 stubbed a renderer store. W3 shipped the canonical one. W3's prompt said "preserve W2's `StripState` union exactly so their imports keep working" — well-intentioned, but the result was two `useStore` exports living in parallel for an hour. W2's slice-2 prompt eventually unified them; we lost two cycles to dual-store drift. **The right move was to ship the canonical store FIRST and have W2 import it from a stub-file W3 would overwrite.** Order beats coordination.

### 4. We never made workers smoke-test through the bridge

Every worker verified `pnpm typecheck` + `pnpm build`. None of them ran the app and clicked the thing they shipped to confirm it round-tripped. We had end-to-end smoke checkpoints (C1-C7) — but they were *user* responsibilities. They should have been *worker DoD*.

### 5. Parallelism overshoot

At peak we had 5 BG agents running concurrently. Coordination overhead — file conflicts on `shared/ipc.ts`, `package.json`, `App.tsx` — ate ~15 minutes of agent + human time. The right shape for this scope was 2-3 lanes max, with rigorous file ownership.

### 6. We pivoted away from the product POV

When the floating overlay strip showed visual bugs (white pill, panel close button), I recommended a pivot to a normal chat window. **Wrong call.** The strip IS the product. A chat window is just another chatbot. Fixing the visual bugs would have taken 10 minutes (vibrancy + body bg + closable:false — eventually shipped anyway as `72de62b`). The chat pivot consumed 30 minutes and left us without our identity at the deadline.

## What to encode in every future agent prompt

A first-draft checklist:

1. **Forbidden patterns** — macOS-reserved shortcuts, system-window controls, file paths owned by other workers, dependencies that aren't yet installed.
2. **Integration smoke test in DoD** — not "typecheck passes" but "I ran the app, I clicked the thing, I saw the expected effect in console + UI."
3. **Specific file pointers with line ranges** — "read `docs/ux-design.md` § Pass 5, Pass 4" not "read the design plan."
4. **Owned IPC channel names** — declare exact channel strings upfront so two workers don't drift on naming.
5. **A "what other lanes will produce" briefing** — even though there's no agent-to-agent comms, I (the bus) describe contracts both sides agree to.
6. **A `STOP_IF` clause** — "If you complete your scope before the budget, STOP. Do not pad work."

## What to keep doing

- Deep design upfront (7-pass review, research docs). Once we got past the design stage, every agent had clear opinions to align to.
- Pencil mockups as the visual source of truth. Worth every minute spent.
- Honest commit messages + frequent pushes. The git log is a real record.
- Side store as architectural source of truth (per compaction research). Holds up.

## The big design decision to revisit

**The strip vs. chat window**: revert to strip. The chat window is fine as a debug/secondary view, but the product is the ambient strip + Canvas duet. Phase 4 of the roadmap pivots us back.
