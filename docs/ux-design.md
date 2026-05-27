# Director — UX Design Plan

Working design plan, built up through the 7-pass design review. This is the source of truth for the Strip / Hive / Canvas UI. Once stable, the design-system portions (tokens, type, motion, glass spec) get extracted into `DESIGN.md`.

> **Status**: in-progress. Pass 1 complete. Passes 2–7 pending.

---

## Pass 1 — Information Architecture ✅

### Spatial model

- **Strip** lives on the right edge of the primary display, **20px from screen edge**, vertically centered when idle.
- **Strip baseline geometry**: 12 × 180px pill in dormant state; expands to 56 × 320px in Hive mode (room for ~3 agents at standard density); grows vertically to fit up to 4 agents before applying overflow rules (Pass 2 will spec overflow).
- **Strip never exceeds 56px wide** to preserve ambient presence.
- **Multi-monitor**: Strip lives on the display containing the macOS menu bar. No migration on focus change.
- **macOS menu bar status item**: small tray icon for Quit / Preferences / Session log. Always present. Not the primary interface.

### Strip ↔ Canvas relationship (resolved 1B)

When the Canvas opens, **the Strip slides leftward in unison with the Canvas**, ending up as a vertical handle on the Canvas's left edge. Cohesive feel; ambient anchor preserved; grab-to-dismiss gesture is natural.

```
DORMANT                          CANVAS OPEN
─────────                        ──────────────────────────
                                                ┌───┐┌──────────┐
                          ┌───┐                 │ S ││  Canvas  │
  [desktop]               │ S │   [dim desktop] │   ││  content │
                          │   │                 │   ││          │
                          │   │                 │   ││          │
                          └───┘                 └───┘└──────────┘
```

### Hive (agent display inside Strip)

- **Agent ordering**: blocked (top, with attention) → working → done (bottom, dim). Within each group, sorted by dispatch time. Reorders on state transitions with a spring.
- **Hover-to-peek**: hovering Strip with mouse reveals current task micro-text for each agent without summoning. Mouse-leave restores ambient state.
- **Max agents shown without overflow**: 4 (TBD in Pass 2).

### What the user sees, in order, per state

| State | 1st | 2nd | 3rd |
|---|---|---|---|
| Dormant | Slow waveform pulse | — | — |
| Listening | Live mic waveform | Strip glow | — |
| Speaking (AI) | Output waveform (mirrored) | Strip glow | Hive (if work in flight) |
| Working | Topmost agent's ring + micro-text | Other agent rings | Strip frame |
| Thinking (gpt-5.5) | Blue pulse | Reasoning trail text | Hive (paused) |
| Blocked / Escalating | Amber node (jump + chime) | Director's voice | Other Hive nodes |
| Canvas open | Canvas content | Strip-as-handle | Dimmed desktop |

### Decisions deferred to later passes

- Pixel-perfect dimensions per state (Pass 2)
- Overflow strategy for >4 agents (Pass 2)
- Disconnected / error states (Pass 2)
- Cold-boot animation (Pass 2)
- Strip ↔ Canvas slide timing + easing (Pass 5: motion tokens)
- Captions / accessibility transcript (Pass 6)

### What's NOT in scope (Pass 1)

- Windows / Linux layout (Mac-only, decided earlier)
- Notch / Touch Bar interaction (no clear value for v1)
- Picture-in-picture mode when other fullscreen app active (later)

---

## Pass 2 — Interaction State Coverage ✅

### Push-to-talk mechanic (2A-1)

**Default hotkey: `⌘⇧Space`** (reassignable in Preferences).

Smart-key behavior, branched on press duration:
- **Tap (< 200ms press)**: mic toggles open → stays open until next tap (or `⌘⇧M` mute, or `Esc`).
- **Hold (≥ 200ms press)**: mic open *only while key held* → releases on key-up, AI processes the utterance.

Visual tell: tap mode = cyan glow around Strip; hold mode = warmer amber tint to disambiguate.

### Realtime session lifecycle (2B-1) — persistent + seamless rotation

One session open continuously from app launch to quit. Mic muted by default; AI can speak unprompted at any moment for proactive escalation.

**Rotation protocol** (fires every 55 minutes, ahead of the 60-min hard cap):

1. Backend mints `Session_B` in the background with full `session.update` (model, voice, instructions, tools).
2. Backend constructs a **World State Brief** and injects it into `Session_B` as a `system` role `conversation.item.create` before swapping. The brief contains:
   - Active agents and their statuses (`Vera (Frontend): working — writing PlaylistCard.tsx`)
   - Current Harness rules verbatim
   - Last canvas state (component name + props summary + whether awaiting response)
   - Current task / goal in flight
   - Last 6 conversation turns verbatim (transcript items)
   - Time elapsed since session start
3. Frontend swaps WebRTC peer connections during a planned ~200ms silence window (between sentences if AI is speaking; immediate if idle).
4. `Session_A` torn down gracefully.

**The Director's long memory** lives in **gpt-5.5**, not the Realtime session. The full session transcript is streamed to gpt-5.5's context as it happens (long context window). The Realtime session is a windowed view; the orchestrator is the deep memory.

The Realtime layer can query gpt-5.5 for historical recall via the `consult_director` tool — *"what did the user say 20 minutes ago about gradients?"* — and narrate the answer back.

**Persistence to disk**: full transcript + Harness + agent state snapshots written continuously to `~/.director/sessions/<session-id>/` so a quit-and-relaunch can offer to resume.

### Decisions made unilaterally

- **Mic permission denial** → Canvas opens with `form`-shaped permission card + System Settings deeplink + "Try Again" button. No silent fail.
- **Hive overflow (>4 agents)** → top 3 shown (blocked > working > done priority within that), bottom row shows "+N more" pill that expands on hover to reveal a compact collapsed list.
- **Realtime hard disconnect** → quiet degradation. Strip dims grey + tray red dot + single macOS notification *"Director offline — reconnecting"*. No modal. First 30s of reconnect attempts silent; notification updates if it persists past 30s.

### Full interaction state matrix

| Feature | Loading | Empty | Error | Success | Partial |
|---|---|---|---|---|---|
| App boot | Strip slides in from off-screen right (~250ms), fades to dormant glow | — | Boot fail → tray red dot, no Strip, diagnostic on click | Dormant Strip visible | — |
| Realtime session | Hairline ring pulses around Strip while connecting | — | 3-retry fail → Strip grey + macOS notif | Strip dormant, ready | Reconnecting → amber ring pulse, queues last utterance for replay |
| Session rotation | (invisible — happens during silence) | — | Rotation fail → fall back to current session until 60min cap; warn user pre-cap | World State injected into new session, swap <200ms, user notices nothing | If audio mid-flight: wait until sentence end, then swap |
| Summon (hotkey) | Strip brightens within 80ms | (n/a) | Mic permission denied → Canvas form | Listening state, waveform live | Hotkey before Realtime ready → grey pulse + tray haptic |
| User speaking | Live mic waveform on Strip | (n/a) | Mic dropout → amber flash + "didn't catch that" | Speech captured, Realtime ingesting | Low input volume → 〈! glyph |
| Director thinking (gpt-5.5) | Blue pulse + reasoning trail text | (n/a) | Timeout → Strip flashes red briefly, "lost my train" | Narration starts | Long thinking → trail keeps streaming |
| AI speaking | (n/a) | — | TTS network drop → amber flash, restart from sentence | Output waveform smooth | Barge-in → cuts <150ms |
| Agent dispatched | Node spawns into Hive with spring | Hive empty → Strip dormant size | Spawn fail → red node, collapses after 4s, Director narrates | Node lands, green ring | Spawn pending worktree → greyed node, "Preparing worktree…" |
| Agent working | Spinning ring + micro-text trail | (n/a) | Crash → red node, 〈! glyph, Director notified | Ring spinning, recent files trail | Waiting upstream → ring slows, shows dependency |
| Agent blocked | Amber ring + rhythm shift + dual-tone chime + Strip bounce | (n/a) | (blocked IS attention) | Resolved → green ring, soft confirm tone | Multi-block → top blocker spoken first, queued |
| Agent done | Ring solidifies, flash, dims | (n/a) | (done = success) | Solid green, trail frozen | Done-with-warning → solid amber |
| Canvas opening | Strip slides leftward; Canvas spring-expands over ~280ms | (n/a) | Render fail → compact error card + voice apology | Content rendered | Per-asset skeletons |
| Canvas awaiting response | "or say it" mic glyph + soft glow on interactive | (n/a) | 60s silence → gentle re-prompt | Voice/click → 500ms halo + auto-dismiss 400ms after | Form partial → submit disabled, hint on missing |
| Canvas voice resolution | 500ms halo on resolved option | (n/a) | Ambiguous → dual halo + verbal clarification | Locks, `canvas_response` fires | Partial → halo on best match + verbal confirm |
| Canvas dismissing | (n/a) | — | Async work in flight → brief loader + voice outcome | Slides right + collapses to Strip over ~220ms | (n/a) |
| Hive overflow (>4) | (n/a) | — | — | Top 3 + "+N more" pill, hover reveals | Priority: blocked > recent |
| Strip dormant | Slow waveform pulse (1.5s cycle, cyan tint) | — | — | — | — |
| Quit | Strip slides off-screen right with spring (~300ms) | — | — | Tray disappears | — |

---

## Pass 3 — User Journey & Emotional Arc ✅

### Storyboard

| Step | User does | User feels |
|---|---|---|
| 1. First launch | Opens Director.app | Curious + slightly cautious |
| 2. First summon | Hits hotkey, says hi | Minor amazement |
| 3. First brief | Speaks intent | Anticipation |
| 4. First Canvas | Sees moodboard, picks | Agency *(it listens, doesn't just execute)* |
| 5. First parallel dispatch | Watches 4 agents spin up | Surprise + delight |
| 6. First proactive escalation | Hears Director unprompted | Jolted but appreciative *(it talks when I matter)* |
| 7. First Harness rule | Says "no gradients ever" | Ownership *(it's learning my taste)* |
| 8. First artifact reveal | Sees live interactive component | Payoff *(I made this without typing)* |
| 9. Dismiss | "Done for now" | Comfortable *(still there, not in my face)* |
| 10. Return next day | Opens app | Continuity *(picking up where we left off)* |

### Time-horizon design

- **5 seconds (visceral)** — first sight of the Strip's slow waveform pulse in dormant state. Vibrancy + spring sets tone: *intentional, calm, alive*. The dormant pulse must feel **breathing, not pulsing**.
- **5 minutes (behavioral)** — after one full Brief → Canvas → Hive → Reveal cycle, mental model locks: *"I describe, it builds. I correct, it learns. I review, it ships."*
- **5 years (reflective)** — Harness is full of personal rules, Strip feels like a teammate. The relationship is *attended* not *operated*.

### Persona refinements (additive to vision)

- **Preamble before any tool call > 800ms latency.** "On it." / "Looking." / "Thinking." — never "Sure!" or "Of course!"
- **Never says "I" when narrating sub-agent work.** *"Frontend is laying out the card"* not *"I'm laying out the card."* Team metaphor.
- **Brief apology when wrong**, then move on. *"Wrong direction — fixing."* No grovel.
- **Silence is a feature.** Director never says "anything else?" When work is done, Director goes quiet.

### Onboarding (3A-1) — minimal seed

```
T+0s    [Strip slides in from off-screen right, dormant]
T+0.4s  Director: "Hi. Press Command Shift Space when you're ready."
T+0.4s  [Strip shows hint: ⌘ ⇧ Space — fades over 6s]
T+6s    [Strip dormant, hint gone]
```

**Phase 2 note (post-hackathon community use)**: evolve toward conversational onboarding (`"want a tour, or are we starting?"`) without lengthening the experience. Hackathon ships with minimal seed.

### Harness rule save choreography (3B-1) — brief Canvas flash

```
User:   "No gradients ever."
Director: "Saved." (soft confirm tone)
[Canvas slides out ~1.2s with "+ Rule added: No gradients ever" card, fades]
```

The visual proof is the trust-builder. Canvas churn is acceptable cost — saves should *feel* like commits.

### Session resume on launch (3C-1) — soft prompt

```
T+0s    [Strip slides in, dormant]
T+0.6s  Director: "Pick up Mixtape, or start fresh?"
        [Canvas slides out with 2-option picker]
User:   "Resume." → context rehydrates, Strip ready
```

**What "resume" restores**: Harness (always), project metadata (always), conversation context (only if "resume" chosen). Active agents do NOT auto-respawn — clean slate.

## Pass 4 — AI Slop Risk ✅

### The five slop risks and counter-strategies

| Risk | Slop look | Director's counter |
|---|---|---|
| **Generic glass** | Web `backdrop-filter` + neon edges | **Real macOS `NSVisualEffectView`** (under-window, active) — texture from actual wallpaper. Tonal range warm/quiet, not cool/neon. |
| **Agent dashboard cards** | 4 cards in a 2×2 grid with progress bars, status badges | **Not cards.** Each agent = a horizontal row: status disc · named identifier · italic micro-text trail · breadcrumb of recent files. Density calm. |
| **Stock moodboards** | Generic Unsplash tiles labeled Modern / Minimal / Bold | **Bespoke renders.** Each tile is a tiny live render in the option's actual aesthetic — real type, real palette, real motion. An *instance* of the vibe, not an image of it. |
| **ChatGPT-tone narration** | "I'd be happy to help with that…" | **Terse Director persona** (Pass 3). Voice: `marin` or `cedar` (Realtime-exclusive). |
| **Progress bars + spinners** | Linear progress, percentage labels | **Pulse rhythms as language.** Working = slow breathing pulse. Blocked = staccato + chime. Thinking = deeper, slower blue pulse. No percentages, no bars. |

### Hive design (the actual layout)

```
┌─ Strip (Hive mode, 56px wide × ~360px tall) ──────┐
│                                                    │
│  ◐  Maya       Frontend                            │  working — coral name
│  ╰─ wiring the flip animation                      │
│  ╰─ PlaylistCard.tsx · CoverArt.tsx                │
│                                                    │
│  ◑  Jin        Backend                             │  blocked — teal name (amber ring)
│  ╰─ awaiting Stripe key direction                  │
│                                                    │
│  ◐  Cleo       Data                                │  working — ochre name
│  ╰─ writing Mixtape schema                         │
│  ╰─ lib/schema.ts                                  │
│                                                    │
│  ●  Wren       Design                              │  done — plum name (dim ring)
│  ╰─ holographic tokens locked                      │
│                                                    │
└────────────────────────────────────────────────────┘
```

- Status ring sits LEFT of the name (◐ working, ◑ blocked, ◓ thinking, ● done).
- Name carries the agent's personal accent color. Status color stays in the ring only.
- Micro-text italic, dimmed. Files a half-step smaller.

### Agent naming (4A-1) — short human names, role tag

Mixtape demo roster (swappable; specifics finalized in Pass 5):

| Name | Role | Accent | Specialization | Narration tone |
|---|---|---|---|---|
| **Maya** | Frontend | coral | React + Tailwind, composition over inheritance, no CSS-in-JS | Enthusiastic-brief gerunds (*"wiring the flip animation"*) |
| **Jin** | Backend | slate blue | Next.js API routes, Node-idiomatic, edge-friendly handlers | Technical-terse declaratives (*"POST /api/generate routed"*) |
| **Cleo** | Data | ochre | Schemas-first, Zod for runtime validation, file-backed JSON for demo persistence | Methodical statements (*"Mixtape schema written"*) |
| **Wren** | Design | plum | Tailwind tokens, motion primitives, theme tokens, accessibility contrast | Descriptive observations (*"holographic tokens locked"*) |

### Identity depth (4B-1) — visual + specialization + light personality

Each agent's Codex subprocess is spawned with a system prompt seeded from the table above. **Personality affects narration only, never code style** — code follows project conventions exactly.

Example system prompt for Maya:
```
You are the React/UI agent. Idiomatic React, Tailwind utility-first,
compose over inherit. Narrate work in brief enthusiastic gerunds
("wiring the flip animation", "tuning the spring"). Match project
file conventions exactly. Never reference your name or persona inside code.
```

Director references agents by name in narration: *"Maya is on the card. Jin just shipped the generate route."*

## Pass 5 — Design System Alignment ⏳

## Pass 6 — Responsive & Accessibility ⏳

## Pass 7 — Unresolved Design Decisions ⏳
