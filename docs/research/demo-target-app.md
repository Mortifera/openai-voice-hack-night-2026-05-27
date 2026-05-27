# Demo Target App: **Mixtape**

## Concept

**Mixtape** is a vibe-to-playlist card generator. The user types (or speaks) a mood — *"late-night drive through Tokyo neon"*, *"sunday morning espresso"* — and the app produces a beautifully designed, shareable **playlist card**: animated cover art, a curated 8-track list with fake-but-plausible song titles and artists, runtime, and a one-click "share" link. The output is a single interactive React component that lives inside the GenUI Canvas at the end of the demo: hover a track to preview a waveform, click the cover to flip it (cassette/vinyl/holographic), tap share to copy a URL.

It is intentionally a *vibe object* — no real audio, no Spotify auth, no streaming. The product surface is purely **aesthetic generation + interactive card UI + persistence of share links**. That makes it small enough to scaffold in ~7 minutes by parallel Codex sub-agents and visually rich enough that aesthetic judgment calls feel earned.

## Why This Works for the Demo

Mixtape hits every constraint cleanly. It splits into four genuinely independent workstreams (card UI, generation API, persistence, theme system) with only thin JSON contracts between them, so the Agent Hive shows four green rings spinning in parallel without phantom blocking. The output is unavoidably aesthetic — cover art style, card material, typography mood — which creates three natural Canvas moments where the Director must ask the user "which direction?". A missing music-API key and an ambiguous persistence target give two believable blocker moments for proactive voice escalation. And the final artifact — a stylized, flippable, hoverable playlist card — is exactly the kind of thing audiences cheer for when it materializes in the Canvas at T+5:00.

## Workstream Split

| Agent | Responsibility | Key Files |
|---|---|---|
| **`frontend-agent`** | Playlist card React component, flip animation, hover waveform, share button, page route | `app/page.tsx`, `app/m/[id]/page.tsx`, `components/PlaylistCard.tsx`, `components/TrackRow.tsx`, `components/CoverArt.tsx` |
| **`backend-agent`** | `/api/generate` route that turns a vibe string into 8 mock tracks + cover prompt; `/api/mixtape/[id]` GET/POST | `app/api/generate/route.ts`, `app/api/mixtape/[id]/route.ts`, `lib/generator.ts`, `lib/mockTracks.ts` |
| **`data-agent`** | Persistence of generated mixtapes for share links (file-backed JSON store, no DB), ID generation, schema | `lib/store.ts`, `data/mixtapes.json`, `lib/schema.ts`, `lib/id.ts` |
| **`design-agent`** | Tailwind theme tokens, card material variants (vinyl/cassette/holographic), typography pairings, motion primitives | `tailwind.config.ts`, `styles/themes.ts`, `components/ui/Material.tsx`, `lib/motion.ts` |

Interface contracts are tiny: a `Mixtape` type (vibe, tracks[], theme, id) shared via `lib/schema.ts`, written first so the four agents can fan out without waiting on each other.

## Decision Points (Canvas Moments)

1. **T+0:45 — Card material.** After dispatch, Director pauses: *"Three card materials are on the table — matte vinyl sleeve, transparent cassette, or holographic foil. Which one is the product?"* Canvas slides out with three rendered card thumbnails. User picks one; the choice is written to the Harness as the project's visual identity rule.
2. **T+2:15 — Cover art style.** *"I have two cover-art directions for the generator — abstract gradient meshes versus pixel-art dioramas. Pick the lane and I'll lock it in."* Canvas shows two cover examples. The decision flows into `design-agent`'s tailwind tokens and `backend-agent`'s cover-prompt template simultaneously.
3. **T+3:30 — Share card layout.** *"For the share page — full-bleed hero card, or stacked card-plus-tracklist? The first reads like a poster, the second reads like a product."* Canvas previews both layouts side by side. Driven decision propagates to `frontend-agent`'s `app/m/[id]/page.tsx`.

Each decision is a real branch in code, not theater — the Harness rule visibly persists ("flat matte only", "no gradients on covers") and shapes everything downstream.

## Blocker Moments (Proactive Escalation)

1. **T+1:30 — Missing music data source.** `backend-agent`'s spinning ring snaps to amber. Director, unprompted: *"Backend's blocked. The generator wants a Spotify or Last.fm token to source real tracks — none in env. Want me to wire real keys, or have it generate plausible fake tracks via a local seed list so the demo runs offline?"* User: *"Use the local seed — fake tracks are fine."* Director routes the instruction; `backend-agent` falls back to `lib/mockTracks.ts` (a curated 200-entry pool of fake-but-believable artist/title combos). Ring returns to green.
2. **T+4:00 — Ambiguous persistence target.** `data-agent` pauses: should share links survive a server restart? Director: *"Data agent is asking how durable share links need to be. File-backed JSON in `/data` is good for the demo, a real DB is overkill. Confirm file store?"* User: *"File store, ship it."* Harness records: *"prefer file-backed JSON for demo-tier persistence."* Unblocked.

Both blockers are realistic in spirit (a sub-agent genuinely *would* stop on these) and resolvable in one sentence by voice — exactly the proactive-orchestration story the demo sells.

## File Structure Sketch

```
mixtape/
  app/
    page.tsx                  # vibe input + "generate" CTA
    m/[id]/page.tsx           # share page for a saved mixtape
    api/
      generate/route.ts       # POST { vibe } -> Mixtape
      mixtape/[id]/route.ts   # GET/POST persisted mixtape
  components/
    PlaylistCard.tsx          # the hero artifact (flippable)
    TrackRow.tsx              # hover waveform
    CoverArt.tsx              # animated SVG/CSS cover
    ui/Material.tsx           # vinyl | cassette | holographic
  lib/
    schema.ts                 # Mixtape type (shared contract)
    generator.ts              # vibe -> tracks + cover prompt
    mockTracks.ts             # offline seed pool
    store.ts                  # file-backed persistence
    id.ts                     # short share-id generator
    motion.ts                 # spring presets
  styles/
    themes.ts                 # token sets per material
  data/
    mixtapes.json             # persisted shares
  tailwind.config.ts
```

## 5-Minute Demo Timeline

- **T+0:00** — User: *"Director, build me a vibe-to-playlist app called Mixtape."* Strip expands; Director confirms scope in one sentence and dispatches four agents. Agent Hive shows four green rings spinning, micro-text cascading.
- **T+0:30** — `data-agent` writes `lib/schema.ts` first; other three agents pick it up. Audience sees the contract land, then four streams fan out.
- **T+0:45** — **Decision 1 (card material).** Canvas slides out, three thumbnails. User picks vinyl. Harness rule saved. Canvas slides away.
- **T+1:30** — **Blocker 1 (no music API).** Backend ring amber, dual-tone chime. Director escalates. User says *"mock it"*. Ring green. Audience laughs.
- **T+2:15** — **Decision 2 (cover art style).** Canvas shows abstract gradient vs pixel diorama. User picks gradient. `design-agent` and `backend-agent` both consume the decision.
- **T+3:00** — Frontend node's micro-text shows *"PlaylistCard flip animation..."*, design node shows *"holographic foil tokens..."* — clearly visible parallel labor.
- **T+3:30** — **Decision 3 (share layout).** Canvas previews two layouts. User picks full-bleed poster.
- **T+4:00** — **Blocker 2 (persistence).** Data ring amber. Director asks; user says file store. Ring green.
- **T+4:30** — All four rings glow steady. Soft completion chime. Director: *"Mixtape is compiled. Want to see it?"*
- **T+4:45** — Canvas slides out one last time. Live React component renders inside it. User speaks a vibe — *"late-night drive through Tokyo neon"* — and a real card materializes. Presenter clicks the cover; it flips with a spring. Hovers a track; a waveform shimmers. Clicks share; the URL toast appears.
- **T+5:00** — Applause.

The final artifact is the demo's punchline: the audience watched four agents build it in parallel, watched the user steer it three times by voice, watched it recover from two blockers without anyone touching a keyboard — and now it works, on the desktop, as a thing they want to use.
