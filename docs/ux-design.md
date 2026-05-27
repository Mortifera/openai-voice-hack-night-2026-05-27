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

## Pass 3 — User Journey & Emotional Arc ⏳

## Pass 4 — AI Slop Risk ⏳

## Pass 5 — Design System Alignment ⏳

## Pass 6 — Responsive & Accessibility ⏳

## Pass 7 — Unresolved Design Decisions ⏳
