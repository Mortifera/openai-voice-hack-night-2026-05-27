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

## Pass 2 — Interaction State Coverage 🚧 (in progress)

(filled in below as the review proceeds)

---

## Pass 3 — User Journey & Emotional Arc ⏳

## Pass 4 — AI Slop Risk ⏳

## Pass 5 — Design System Alignment ⏳

## Pass 6 — Responsive & Accessibility ⏳

## Pass 7 — Unresolved Design Decisions ⏳
