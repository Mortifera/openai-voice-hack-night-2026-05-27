# Demo Timeline — Mixtape, in 5 minutes

The spine of the live demo. Every workstream wires against this doc.

- **W1** routes the tool calls in the "Tool" column to/from Realtime.
- **W3** the agent simulator fires the state mutations on the timecode in this doc.
- **W4** Canvas window renders the components listed.
- **W5** orchestration glues sim ticks → tool dispatches → Realtime narrations.
- **You** the presenter memorize the lines under "User says."

Target wall clock: **5 minutes total** (300 seconds). All timestamps are wall-clock from T+0 = user's first utterance.

---

## Characters

| Voice | Who | How they sound |
|---|---|---|
| **You** | The presenter (driving Director) | Casual, direct, like talking to a colleague. Don't recite — react. |
| **Director** | gpt-realtime-2 with voice=marin | Calm, brief, no filler. Never "Sure!", "Of course!", or "I'd be happy to". Acknowledges in 1–2 words. Refers to agents by name, never "I" for their work. |
| **Maya** | (simulated — never voiced) | Frontend agent. Coral name. Enthusiastic-brief gerunds in trail text. |
| **Jin** | (simulated — never voiced) | Backend agent. Teal name. Technical-terse declaratives. |
| **Cleo** | (simulated — never voiced) | Data agent. Ochre name. Methodical statements. |
| **Wren** | (simulated — never voiced) | Design agent. Plum name. Descriptive observations. |

---

## The 4 Tool Calls

Director's Realtime session exposes exactly 4 tools. Every state change in the demo flows through one of them.

```ts
// 1. render_canvas({component, props, component_id?})
// Opens Canvas window with a typed component. Auto-dismisses on canvas_response.
// Returns: {ok: true} immediately. Result of user choice arrives later as canvas_response.

// 2. dispatch_agent_mock({name, role, task})
// Adds an agent to the Hive in "working" state. Sim drives further state changes from here.
// Returns: {ok: true, agent_id: string}.

// 3. ask_user({question, options?: string[]})
// Director speaks a question proactively (driven by sim's escalation event).
// Returns: {answer: string} after user responds.

// 4. update_harness({rule, why})
// Persists a rule. Triggers Canvas/HarnessRuleSave 1.2s flash.
// Returns: {ok: true, harness_count: number}.
```

---

## Timeline

### T+0:00 — Brief

| Beat | What happens |
|---|---|
| **You say** | "Director, let's pick up Mixtape. I want to finish the playlist card." |
| **Director says** | "On it. Where do you want to start?" |
| **Tools** | (none yet) |
| **State** | stripState: listening → thinking (gpt-5.5 consults) |
| **UI** | Strip listening waveform → blue thinking pulse |

### T+0:20 — Aesthetic decision

| Beat | What happens |
|---|---|
| **You say** | "The card material. I haven't picked yet. Show me options." |
| **Director says** | "Pulling three directions. Cassette, vinyl, holographic." |
| **Tools** | `render_canvas({component:"moodboard", component_id:"card-mat-1", props:{title:"Card material", concepts:[matte-vinyl, cassette, holographic]}})` |
| **State** | stripState: hive (because Director is about to dispatch agents, but Canvas opens first) |
| **UI** | Canvas window slides out with 3 tiles using pre-gen images |

### T+0:40 — User picks

| Beat | What happens |
|---|---|
| **You say** | "The cassette one." |
| **Director says** | "Cassette it is." |
| **Tools** | Realtime resolves "cassette one" → option_id "cassette" → canvas_response. Director then: `update_harness({rule:"Cards use cassette material — translucent amber, vintage warmth", why:"User picked cassette during card material decision"})` |
| **State** | canvas: dismissed. harness gets +1 rule. |
| **UI** | Cassette tile gets green halo, Canvas slides closed, HarnessRuleSave flash for 1.2s |
| **Audio** | confirm tone |

### T+0:55 — Dispatch

| Beat | What happens |
|---|---|
| **Director says** | "Dispatching the team." |
| **Tools** | 4× `dispatch_agent_mock({name:"Maya", role:"frontend", task:"PlaylistCard component with flip animation"})`, then Jin, Cleo, Wren. |
| **State** | stripState: hive. 4 agents added in working state. |
| **UI** | Strip resizes to 280×420. 4 AgentRows materialize with spring layout. Status discs green. Micro-text trails populate. |
| **Audio** | Soft tick per agent (4 ticks total, ~80ms apart) |

### T+1:15 — Agents work (silence + visual progress)

| Beat | What happens |
|---|---|
| **You** | (Watch the Hive. Optionally narrate to audience: *"I can keep working. Director will tell me when it needs me."*) |
| **Director says** | (nothing) |
| **Tools** | (none — sim drives trail text changes via internal state) |
| **State** | Sim updates each agent's trail every ~15s: Maya: "wiring the flip animation" → "tuning the spring physics" → "writing CoverArt SVG". Jin: "POST /api/generate routed" → "writing mock-track seed". Cleo: "Mixtape schema written" → "file-backed store going". Wren: "matte tokens locked" → "cassette palette tuning". |
| **UI** | Trail micro-text cascades, files breadcrumb updates |

### T+1:45 — Jin blocks

| Beat | What happens |
|---|---|
| **Sim event** | At T+1:45, sim flips Jin status from working → blocked. |
| **State** | Jin's status: blocked. blocker text: "Stripe staging API key not in env." |
| **UI** | Jin's row pulses amber. Strip bounces once. Dual-tone chime. Jin moves to top of Hive. |
| **Director says (unprompted)** | "Grabbing your attention. Jin's blocked — Stripe staging keys aren't in the environment. Want me to wire real keys, or have Jin generate plausible mock tracks from a local seed list?" |
| **Tools** | `ask_user({question:"...", options:["wire real keys", "use mock seed"]})` |
| **Audio** | Escalation tone (dual 320+480Hz, slight upglide) |

### T+2:10 — User resolves

| Beat | What happens |
|---|---|
| **You say** | "Use the mock seed. Real keys later." |
| **Director says** | "Mock seed it is. Jin's back on it." |
| **Tools** | ask_user resolves → returns answer to sim. Director: `update_harness({rule:"For demo-tier persistence, prefer mock data over external API keys", why:"User chose mock seed during Jin's Stripe blocker"})` |
| **State** | Jin status: blocked → working. trail: "injecting mock track seed" |
| **UI** | Amber pulse stops, ring returns to green, Jin slides back into normal sort order. HarnessRuleSave flash 1.2s. |
| **Audio** | Confirm tone |

### T+2:30 — More work (silence)

| Beat | What happens |
|---|---|
| **Director** | (silent) |
| **State** | All 4 agents in "working". Sim continues trail updates. |
| **You** | (optional aside to audience: *"That's the bargain — I get interrupted only when it matters."*) |

### T+3:15 — Cleo finishes first

| Beat | What happens |
|---|---|
| **Sim event** | Cleo status → done at T+3:15. |
| **State** | Cleo.status: done. trail: "schema + store committed". files: "3 files · 71 lines" |
| **UI** | Cleo's row dims (status=done). Soft tick. |
| **Audio** | Tick (~880Hz, 40ms) |

### T+3:30 — Wren finishes

| Sim event | Wren.status: done. trail: "cassette tokens shipped". files: "2 files · 48 lines" |
| **Audio** | Tick |

### T+3:50 — Jin finishes

| Sim event | Jin.status: done. trail: "generate route + mock seed shipped". files: "2 files · 96 lines" |
| **Audio** | Tick |

### T+4:10 — Maya finishes (the punchline)

| Sim event | Maya.status: done. trail: "PlaylistCard ready to flip". files: "4 files · 184 lines" |
| **Audio** | Tick |
| **State** | All agents done. |
| **UI** | All 4 rows show done state. Hive holds for 2 beats. |

### T+4:20 — The reveal

| Beat | What happens |
|---|---|
| **Director says** | "Mixtape's ready. Want to see it?" |
| **Tools** | (waits for user) |

### T+4:25 — You say yes

| Beat | What happens |
|---|---|
| **You say** | "Yeah, show me." |
| **Director says** | "Try a vibe." |
| **Tools** | `render_canvas({component:"artifact_preview", component_id:"mixtape-final", props:{title:"Mixtape", vibe_prompt:"try anything", view:"empty"}})` |
| **State** | canvas: open with artifact_preview |
| **UI** | Canvas slides out with empty card frame + vibe input field |

### T+4:35 — You type the vibe

| Beat | What happens |
|---|---|
| **You say (or type)** | "Late night drive through Tokyo neon." |
| **Director says** | (silent — let the visual speak) |
| **Tools** | `render_canvas({component:"artifact_preview", component_id:"mixtape-final", props:{title:"Mixtape", vibe:"Late night drive through Tokyo neon", cover_path:"/assets/tokyo-neon.png", tracks:[...6 tracks]}})` (re-render with content) |
| **State** | canvas updates with mixtape content |
| **UI** | Cover art fades in (the pre-gen Tokyo neon PNG), tracklist staggers in, "8 tracks · 31 min" footer |
| **Audio** | Done arpeggio (660→440→330Hz over 400ms) |

### T+4:55 — The flip (the wow)

| Beat | What happens |
|---|---|
| **You** | Click the cover. |
| **UI** | 3D rotateY flip animation — back of card shows credits / share button / fake QR. |
| **Director says** | (silent. let it land.) |

### T+5:00 — End

Stop talking. Let the silence sell it.

---

## Sim tick schedule (W3 implements this verbatim)

```ts
// Pseudo-code for the simulator. All times relative to startMixtapeDemo() call.
const TIMELINE = [
  { at:  0,    do: () => store.setListening() },
  { at:  4,    do: () => store.setThinking() },           // ~when user finishes the brief
  { at: 20,    do: () => /* render_canvas moodboard triggered via tool call from Director */ },
  { at: 40,    do: () => /* canvas_response cassette → update_harness */ },
  { at: 55,    do: () => store.enterHive() },             // 4 dispatch_agent_mock calls fire
  { at: 55,    do: () => store.addAgent({name:"Maya", ...}) },
  { at: 56,    do: () => store.addAgent({name:"Jin",  ...}) },
  { at: 57,    do: () => store.addAgent({name:"Cleo", ...}) },
  { at: 58,    do: () => store.addAgent({name:"Wren", ...}) },
  { at: 75,    do: () => store.updateAgent("maya", {trail:"tuning the spring physics"}) },
  { at: 90,    do: () => store.updateAgent("jin", {trail:"writing mock-track seed"}) },
  { at: 105,   do: () => store.updateAgent("maya", {trail:"writing CoverArt SVG"}) },
  { at: 105,   do: () => store.updateAgent("cleo", {trail:"file-backed store going"}) },
  { at: 105,   do: () => store.updateAgent("wren", {trail:"cassette palette tuning"}) },
  { at: 105,   do: () => store.blockAgent("jin", {blocker:"Stripe staging API key not in env"}) },  // ESCALATION TRIGGER
  // …user resolves via ask_user, sim resumes Jin…
  { at: 130,   do: () => store.resolveAgent("jin", {trail:"injecting mock track seed"}) },
  { at: 195,   do: () => store.completeAgent("cleo", {files:"3 files · 71 lines"}) },
  { at: 210,   do: () => store.completeAgent("wren", {files:"2 files · 48 lines"}) },
  { at: 230,   do: () => store.completeAgent("jin",  {files:"2 files · 96 lines"}) },
  { at: 250,   do: () => store.completeAgent("maya", {files:"4 files · 184 lines"}) },
  // …Director offers reveal, user accepts, artifact_preview opens, user inputs vibe, card renders…
];
```

The blocker at T+105 (=1:45) is the escalation trigger — the sim doesn't auto-advance Jin until the orchestration layer (W5) calls `store.resolveAgent("jin", ...)` after `ask_user` returns.

---

## Voice synonym resolution

Each interactive Canvas component must resolve these phrases to canonical option_ids. Realtime's gpt-realtime-2 handles this on the fly, but listing them helps testing:

**Moodboard card material:**
- "cassette" / "the cassette one" / "translucent one" / "amber one" / "middle one" / "the warm one" → option_id: `cassette`
- "vinyl" / "matte one" / "matte vinyl" / "first one" / "left one" / "monochrome one" → option_id: `matte-vinyl`
- "holographic" / "holo" / "shiny one" / "iridescent" / "third one" / "right one" → option_id: `holographic`

**Jin blocker resolution:**
- "mock" / "use mock" / "fake tracks" / "local seed" / "skip the keys" / "mock it" → option: `use mock seed`
- "wire real keys" / "real keys" / "set up Stripe" → option: `wire real keys`

**Final reveal trigger:**
- "yeah" / "yes" / "show me" / "let's see" / "go" → triggers `render_canvas artifact_preview`

---

## Fallback plan (if voice fails mid-demo)

**Failure: Realtime doesn't connect**
- Fall back to manual mode: dev keys 1–7 still trigger Strip states. Sim can be invoked via a debug command.
- Presenter narrates what Director WOULD have said: read the "Director says" column aloud as voice-over.
- The visual demo still works — Hive, Canvas, ArtifactPreview all driven by sim ticks.

**Failure: Mic permission denied**
- macOS dialog appears. Grant manually, then re-press hotkey.
- If denied: fall back to manual sim mode (dev key '5' to enter Hive directly).

**Failure: Canvas window won't open**
- Fall back: render Canvas content INSIDE the Strip window (already big enough for moodboard at 280px). One-line CSS swap.

**Failure: Pre-gen images missing**
- Fall back: render Canvas tiles with solid color blocks (matte-black, warm-orange, gradient).

**Failure: Sim doesn't trigger blocker**
- Manual override: presenter can call `window.__directorSim.blockJin()` from devtools to force the escalation.

---

## What the presenter says — beat sheet

Memorize these lines (the User column above, distilled):

1. *"Director, let's pick up Mixtape. I want to finish the playlist card."*
2. *"The card material. Haven't picked yet. Show me options."*
3. *"The cassette one."*
4. (silent — let the Hive populate, optional narration to audience about parallel work)
5. *"Use the mock seed. Real keys later."* — after Jin blocks
6. (silent — let the Hive finish)
7. *"Yeah, show me."* — when Director offers the reveal
8. *"Late night drive through Tokyo neon."*
9. (silent — click the cover, let the flip land)

That's 8 lines of dialogue. The rest is silence, Director, and visuals.
