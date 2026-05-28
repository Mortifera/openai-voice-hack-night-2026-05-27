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

## Pass 5 — Design System Alignment ✅

Inline DESIGN.md (extracted to standalone `DESIGN.md` after Pass 7). Calibrated against OpenAI's visual identity (warm off-white, near-black, generous whitespace, conservative type, sparse accents) **without** copying.

### Type stack

Inter + JetBrains Mono — both free. Söhne (OpenAI's paid choice) is the post-hackathon swap. Inter is the canonical free analog by Rasmus Andersson in the same lineage.

- Display / labels / narration text: **Inter** (variable, 400/500/600)
- Code (`code_preview`, `diagram`): **JetBrains Mono** (variable, 400/500)
- Scale: 11 / 12 / 14 / 18 / 24px. No large display sizes — overlay app.

### Color palette (dark-only v1)

| Token | Value | Use |
|---|---|---|
| `--surface-base` | `rgba(20, 20, 22, 0.55)` | Glass base behind macOS vibrancy |
| `--surface-elevated` | `rgba(28, 28, 32, 0.72)` | Canvas cards |
| `--text-primary` | `#ECECF0` | Default text |
| `--text-secondary` | `#9B9BA0` | Micro-text, file paths, tags |
| `--text-tertiary` | `#5E5E62` | Dim hints |
| `--border-subtle` | `rgba(255,255,255,0.08)` | 0.5px hairlines |
| `--status-working` | `#58D68D` | Working ring (calm, not neon) |
| `--status-blocked` | `#E8A95C` | Blocked amber |
| `--status-thinking` | `#6E94E8` | gpt-5.5 thinking pulse |
| `--status-done` | `#9B9BA0` | Done (dim neutral) |
| `--status-error` | `#E07866` | Hard error (warm red) |
| `--accent-maya` | `#E07856` | Frontend identity (coral) |
| `--accent-jin` | `#4A9E9C` | Backend identity (teal) |
| `--accent-cleo` | `#C99550` | Data identity (ochre) |
| `--accent-wren` | `#9670A0` | Design identity (plum) |

All agent accents ≤70% saturation — readable as names, never confusable with status semantics.

### Motion tokens

| Token | Value | Use |
|---|---|---|
| `--spring-default` | stiffness 180, damping 22 | Node spawn, Canvas open |
| `--spring-snappy` | stiffness 280, damping 26 | Hotkey response, barge-in |
| `--ease-smooth` | `cubic-bezier(.32, .72, 0, 1)` | Slide animations |
| `--duration-quick` | 180ms | Fades, micro-feedback |
| `--duration-base` | 260ms | Strip ↔ Canvas slide |
| `--duration-canvas-open` | 280ms | Canvas spring expand |
| `--pulse-dormant` | 1.5s sine | Strip dormant breathing |
| `--pulse-blocked` | 0.6s staccato | Blocked agent ring |

### Spacing

Base scale: 4 / 8 / 12 / 16 / 24 / 32 px.

### Glass spec

Electron `BrowserWindow`:
- `vibrancy: 'under-window'`
- `visualEffectState: 'active'`
- `transparent: true`
- `frame: false`
- `alwaysOnTop: ('floating', 'screen-saver')`

Geometry:
- Strip corner radius: **14px**
- Canvas corner radius: **22px**
- Border: 0.5px solid `--border-subtle`
- Shadow: `0 8px 32px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.25)`

### Iconography

- **Director has no logo on the Strip.** The waveform pulse IS the brand mark.
- Tray icon: monochrome glyph (vertical pill silhouette with center dot).
- In-Canvas icons (form fields, buttons): **Lucide** (open-source, calm, consistent stroke).

### Sound palette

| Cue | Specification |
|---|---|
| Confirm | 440 Hz + 660 Hz dyad, 80ms decay |
| Tick (sub-task complete) | 880 Hz pluck, 40ms decay |
| Escalation | 320 Hz + 480 Hz dyad, 200ms decay, slight upglide |
| Done (work complete) | Descending 660 → 440 → 330 Hz arpeggio, 400ms |
| Voice-recognized halo | Ultra-soft 1.2 kHz blip, 60ms |

### Phase-2 swaps

- Söhne family (paid license) replaces Inter / JetBrains Mono once funded
- Light mode added (vibrancy materials switch to `.popover` light variant)

## Pass 6 — Responsive & Accessibility ✅

### Display + window behavior

| Concern | Decision |
|---|---|
| Multi-monitor | Strip lives on primary display (the one with the menu bar). No migration. |
| Notch (MacBook Pro 14/16) | N/A — Strip is on right edge, not top. No collision. |
| Dock on right edge | Strip slides 20px left of dock (detect via `screen.getPrimaryDisplay().workArea.x + width`). |
| Fullscreen apps | Strip stays visible via `alwaysOnTop: 'screen-saver'` level + `setVisibleOnAllWorkspaces(true)`. |
| Mission Control | Strip visible but excluded from window cycler (`setExcludedFromShownWindowsMenu(true)`). |
| Multiple Spaces | Strip follows the user across all Spaces. |
| Display scaling (Retina / external) | CSS pixels — natural scaling. Test on 1x, 2x, 3x DPR. |
| Window resize / re-arrangement | Strip re-anchors to right edge on `display-metrics-changed`. |

### Keyboard navigation

| Surface | Keyboard contract |
|---|---|
| Strip (no Canvas open) | `⌘⇧Space` summon (Pass 2). `⌘⇧M` mute mic. `⌘.` stop current work. `⌘Q` quit (via tray). |
| Canvas open | `Tab` cycles interactive elements. `Arrow keys` navigate within (`options_picker`, `moodboard`). `Enter` commits selection. `Esc` dismisses Canvas (fires `canvas_response({ dismissed: true })`). |
| Forms in Canvas | Standard form keyboard. `⌘Enter` submits. `Tab` cycles fields. |
| `code_preview` | `Y` approve, `N` reject, `R` request changes (when shown). |

### Focus indicator

2px ring in `--status-thinking` (#6E94E8) with 4px offset on all focusable elements. Never just `outline: none`.

### Screen reader (VoiceOver)

- Strip: `role="status"`, `aria-live="polite"`, label describes current state ("Listening", "Maya is working on PlaylistCard", "Director thinking").
- Hive nodes: `role="status"` per row, label = `"Maya, Frontend, working, wiring the flip animation"`.
- Canvas: `role="dialog"`, `aria-modal="true"` (focus trap inside Canvas while open).
- `options_picker`: `role="radiogroup"`, each option `role="radio"`.
- `form`: native form semantics + `aria-required` on required fields.
- AI narration: optional live region (deferred to caption toggle, see below).

### Contrast

- `--text-primary` (`#ECECF0`) on `--surface-elevated` (over vibrancy): targets **WCAG AA 4.5:1**. Real contrast varies with wallpaper underneath vibrancy — mitigation: text-shadow `0 1px 2px rgba(0,0,0,0.4)` on all surface text to preserve readability across light wallpapers.
- Status colors checked individually:
  - `--status-working` #58D68D on dark surface: ≥7:1 ✅
  - `--status-blocked` #E8A95C on dark: ≥7:1 ✅
  - `--status-thinking` #6E94E8 on dark: ≥4.5:1 ✅
  - `--status-error` #E07866 on dark: ≥4.5:1 ✅
- Agent accent colors on text: all ≥4.5:1 on `--surface-elevated`.

### Reduced motion

Honor `prefers-reduced-motion: reduce` strictly:
- Springs → instant or 80ms linear fade
- Slide animations → cross-fade in `--duration-quick`
- Pulses → static dimmed fill instead of cycling
- Canvas open → instant (no spring expansion)
- Voice halo resolution → soft fill instead of expanding ring

### Font scaling

Inter scales to user's preferred text size. Detect via `window.matchMedia('(prefers-larger-text)')` (Safari) or read from Electron's accessibility preferences. Scale base font 1.0x → 1.25x. Spacing scale follows.

### Touch / trackpad

- Trackpad click hit targets ≥36px (all current rows >70px, safe).
- Two-finger swipe right on Canvas → dismiss (matches macOS gesture grammar).
- Hover-to-peek on Strip respects `pointer: fine` (mouse only, not trackpad gesture).

### Captions (deferred to phase 2)

Visible mirror of Director's narration as subtitled text on the Strip. Critical for deaf/HoH users and noisy environments. **Phase 2 work** — adds a Preferences toggle and a small caption track that fades sentences in/out below the Strip. Logged in Pass 7 TODOs.

### What's NOT in scope

- Windows / Linux a11y conventions (not yet)
- High-contrast mode override (relies on system contrast for now)
- Touch screen support (Mac → not applicable)
- Localization / RTL languages (English-only v1)

## Pass 7 — Unresolved Design Decisions ✅

### Resolved decisions

| ID | Decision |
|---|---|
| 7A-1 | **`⌘.` semantics — tiered.** Tap = soft stop (Director stops talking, agents continue). Hold = hard stop (agents wrap at next checkpoint). Double-tap = panic (immediate kill, worktrees preserved). |
| 7B-1 | **DND mode — auto-honor macOS Focus.** When any macOS Focus is enabled, escalations queue silently (amber Strip pulse + tray badge). User summons to drain the queue. No new toggle. |
| 7C-1 | **Hotkey conflict detection on first launch.** App tests `⌘⇧Space` registration. If blocked (Spotlight on some setups, third-party tools), open a Canvas `options_picker` offering 3 alternative chords (`⌥Space`, `⌘⇧;`, `⌘⌥D`). User picks; choice persists. |
| — | **Voice/click race window**: 200ms. Click wins ties. |
| — | **Multi-canvas calls**: most-recent-wins with cross-fade; if prior was interactive, auto-fires `canvas_response({ dismissed: true })`. |
| — | **Dormant Strip hover-peek**: 800ms hover → `⌘⇧Space` hint fades in; mouse-leave fades it out. |
| — | **Agent naming beyond Mixtape**: pool of 16 candidates auto-assigned by role hash. User can rename via voice. |
| — | **Worktree cleanup**: persist by default; manual "Clean session worktrees" in tray. |
| — | **Mic permission**: macOS native prompt first; Canvas `form` only on denial. |
| — | **Captions**: deferred entirely to phase 2. |
| — | **Presenter / debug mode**: deferred. |

### Not in scope (explicitly deferred)

| Item | Why deferred | When |
|---|---|---|
| Light mode | Vibrancy + dark feels Mac-native; light mode is a polish item | Post-hackathon |
| Captions / live transcript | Critical for deaf/HoH and noisy environments; nontrivial implementation | Phase 2 |
| Söhne font licensing | Inter is free, perceptually adjacent for hack night | Post-hackathon if monetized |
| Windows / Linux | Mac-only v1 locked | Post-hackathon if community wants it |
| Conversational onboarding | Minimal-seed onboarding ships v1; conversational welcome (3A-4) is the next iteration | Phase 2 |
| Localization / RTL | English-only v1 | Post-hackathon |
| Always-listening with wake word | Push-to-talk locked v1 (2A-1); requires local wake-word model and continuous mic | Phase 2 |
| Pair / observer mode | Single user locked | Phase 3 |
| Pencil-driven theme overrides | Hackathon ships fixed token set | Phase 2 |

### What already exists (leveraged from prior research)

- `docs/vision.md` — aesthetic POV, three UI states, persona DNA
- `docs/research/genui-schema.md` — 7 prebuilt Canvas components + raw-HTML escape hatch
- `docs/research/genui-interaction-modes.md` — voice/click duality, prose components, race rules
- `docs/research/gpt-realtime-2.md` — Realtime API: preamble, thinking phase, 60-min cap, proactive escalation pattern
- `docs/research/compaction.md` — orchestrator memory is opaque, side store is source of truth
- `docs/research/codex-for-everything.md` — `@openai/codex-sdk` exists, `AGENTS.md` per worktree carries agent identity
- `docs/research/demo-target-app.md` — Mixtape concrete demo scenario

### TODOS.md items (logged separately)

See `TODOS.md` at repo root.

---

## Completion Summary

```
+====================================================================+
|         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
+====================================================================+
| System Audit         | No DESIGN.md prior; high UI scope; vision +
|                      | research docs provided strong POV
| Step 0               | Initial 4/10; focus: full 7-pass per user brief
| Pass 1  (Info Arch)  | 3/10 → 9/10 (Strip ↔ Canvas resolved 1B)
| Pass 2  (States)     | 2/10 → 9/10 (PTT 2A-1, session 2B-1, full state matrix)
| Pass 3  (Journey)    | 2/10 → 9/10 (onboarding 3A-1, harness 3B-1, resume 3C-1)
| Pass 4  (AI Slop)    | 3/10 → 9/10 (naming 4A-1, identity depth 4B-1)
| Pass 5  (Design Sys) | 1/10 → 8/10 (inline DESIGN.md; tokens defined)
| Pass 6  (Responsive) | 2/10 → 8/10 (multi-display + a11y + reduced motion)
| Pass 7  (Decisions)  | 3 resolved (7A, 7B, 7C); 8 auto-decided; 9 deferred
+--------------------------------------------------------------------+
| NOT in scope         | written (9 items)
| What already exists  | written (7 sources)
| TODOS.md updates     | to be written (separate file)
| Decisions made       | 14 added to plan
| Decisions deferred   | 9 (listed above)
| Overall design score | 4/10 → 8/10
+====================================================================+
```

Plan is design-complete for hackathon shipping. Pencil mockups next.
