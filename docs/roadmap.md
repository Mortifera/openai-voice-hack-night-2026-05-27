# Director — Post-Hackathon Roadmap

> Status as of 2026-05-27 ~18:30 PDT. Phases assume 1–2 concurrent workers, no clock.

## Phase 1 — Integration recovery (1–2 hours)

The chat UI works visually but the preload bridge doesn't surface in the renderer. Fix that, smoke-test the full voice + tool loop, then restore the strip overlay.

| ID | Task | Files | Verification |
|---|---|---|---|
| 1.1 | Diagnose preload bridge — `window.director` missing | `apps/director/src/preload/index.ts`, `apps/director/src/main/index.ts` (BrowserWindow opts) | `window.director` non-null in devtools |
| 1.2 | Fix root cause (likely `sandbox: true` + non-`.cjs` preload OR an import-time throw) | preload, webPreferences | Mic button transitions closed → minting → connected |
| 1.3 | End-to-end smoke test: text-send → AI replies | App.tsx Send button → Realtime → AI audio | Audio plays, transcript appears in chat |
| 1.4 | Voice round-trip: mic → AI → audio | Hyper-Space hotkey path | Same as above, via voice |
| 1.5 | Tool routing: Show Moodboard / Show Artifact buttons fire Canvas | App.tsx onClick → `window.director.tool.call` → tool-router → canvas.render | Canvas window opens with right component |
| 1.6 | Sim integration: Start Mixtape Demo → Hive populates → Jin blocks → Director speaks unprompted | `state/sim.ts`, escalation event listener in App.tsx | Director speaks the suggested_question via audio at T+50s (compressed) |

**DoD**: a presenter can run the full Mixtape demo end-to-end without VO.

## Phase 2 — Restore the Strip (1–2 hours)

The chat window was a panic move. The strip is the product. Restore it; keep the chat as an optional secondary view for debugging.

| ID | Task |
|---|---|
| 2.1 | Re-apply original BrowserWindow options: `transparent: true`, `vibrancy: 'under-window'`, `frame: false`, `closable: false`, `type: 'panel'`, no `titleBarStyle: hidden`. Right-edge anchored geometry. |
| 2.2 | Restore Strip rendering: dormant → listening → speaking → thinking → hive based on `stripState`. Keep transitions from W2's slice-2. |
| 2.3 | Add a hidden "expand to chat" affordance (e.g., right-click tray → Show Chat Window) so the chat UI lives on as a debug surface. |
| 2.4 | Visual QA against Pencil frames `EodJh / WTc1y / TiVyu / v2ONzK / yl2Zx / BzAdB`. Screenshot each state, compare. |

**DoD**: ambient strip on right edge of screen with breathing pulse. ⌘⇧Space summons. Hive renders in-strip with 4 agents.

## Phase 3 — The gpt-5.5 planner tier (3 hours)

Today Realtime acts as Director directly. The full architecture has Realtime as the *voice* tier with a deeper planner behind it.

| ID | Task |
|---|---|
| 3.1 | New tool on Realtime session: `consult_director({ prompt, context })`. |
| 3.2 | Main-process planner service: Responses API client, `gpt-5` (or current top reasoning model), `reasoning.effort: "high"`, persistent thread or stateless-with-side-store. |
| 3.3 | Stream reasoning summary back to Realtime as text → Realtime narrates it as audio. Side store updates ride along. |
| 3.4 | Side store crystallized: `harness.json`, `decisions.jsonl`, `agents/<id>.json`, `transcript.jsonl`. All atomic-write semantics. |
| 3.5 | Compaction strategy per `docs/research/compaction.md` — periodic `/responses/compact` calls at quiescent moments, never mid-stream. |

**DoD**: when user gives a high-level prompt ("design a Mixtape sharing feature"), Realtime calls `consult_director`, the planner produces a structured work breakdown, sub-agents are dispatched against the breakdown, and the user hears the planner's reasoning summary streamed back as voice.

## Phase 4 — Real Codex sub-agents (3–4 hours)

Replace the timer-driven simulator with actual Codex CLI subprocesses building real software.

| ID | Task |
|---|---|
| 4.1 | Install `@openai/codex-sdk`. Read its source for the event taxonomy. |
| 4.2 | Per-agent identity via `AGENTS.md` files dropped into worktrees at dispatch time (Maya / Jin / Cleo / Wren). Each agent's `AGENTS.md` is its system prompt + specialization. |
| 4.3 | Spawn manager: 4-process semaphore pool, git worktree per agent, JSONL stdout parser. |
| 4.4 | State Machine integration: Codex events (`file_change`, `command_execution`, `error`, `turn.completed`) drive `addAgent / updateAgent / blockAgent / completeAgent`. |
| 4.5 | Worktree merge protocol: when all agents done, fan-in to a single branch. |
| 4.6 | Dogfood: have Director actually build the unfinished Mixtape TODOs (`PlaylistCard`, share page, store, themes) — the demo timeline becomes literally true. |

**DoD**: pressing "Start Mixtape Demo" actually spawns 4 Codex processes that complete `examples/mixtape`'s remaining TODOs in parallel git worktrees.

## Phase 5 — Polish + Captions (2 hours)

| ID | Task |
|---|---|
| 5.1 | Live caption track on the Strip (Pass 6 phase-2 item). |
| 5.2 | Audio cue synthesis per Pass 5 sound palette: confirm, tick, escalation, done, halo. |
| 5.3 | Strip-as-handle when Canvas opens (Pass 1 decision 1B). |
| 5.4 | Hover-to-peek on dormant Strip. |
| 5.5 | Onboarding minimal-seed (Pass 3 — 3A-1). |

## Phase 6 — Session resilience (2 hours)

| ID | Task |
|---|---|
| 6.1 | 55-min Realtime session rotation with World State Brief injection. |
| 6.2 | Reconnect / disconnect UX — Pass 2 state matrix. |
| 6.3 | Session resume on launch (Pass 3 — 3C-1). |

## Sequencing

```
Day 1 (4 hours):     Phase 1 → Phase 2
Day 2 (6 hours):     Phase 3 || Phase 4 (in parallel)
Day 3 (4 hours):     Phase 5 → Phase 6
                     Polish + recording + distribution
```

Phase 3 and Phase 4 can parallelize because gpt-5.5 planner work doesn't touch Codex execution. Both depend on Phase 1 (integration recovery) and benefit from Phase 2 (strip restored).

## Parallelism rules (lessons from hackathon)

1. **Max 2 concurrent workers** on this scope. Three or more = coordination loss > parallelism gain.
2. **One worker owns each shared file**. If two workers must touch the same file, they go serial.
3. **Every prompt includes**:
   - File pointers with section names (`docs/X.md § Y`)
   - Forbidden patterns list
   - "What other lanes will produce" contract (channel names, types, shapes)
   - Integration smoke test in DoD (not just typecheck/build)
   - Explicit `STOP_IF complete` clause
4. **Workers commit and push every meaningful step**. Pull-rebase is on by default. No co-signing.

## Open questions for the planning conversation

- Where does the gpt-5.5 planner client live — Electron main process, or a separate Node service?
- Codex subprocesses: real CLI, or hosted (Codex Cloud)?
- Strip ↔ Chat: separate windows or one with a "modal" expand?
- Multi-user: out of scope or planned for later?
- Distribution: DMG + auto-update before or after Phase 3?
