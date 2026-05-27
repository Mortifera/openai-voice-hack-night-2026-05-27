# GenUI Canvas — Component Schema

## Overview

The Canvas is a frosted-glass panel that slides in from the right edge when the Director needs a visual judgment from the user. The orchestrator (`gpt-5.5`) invokes it via a single tool: `render_canvas({ component, props, component_id?, layout? })`, where `component` is one of a small typed set of prebuilt React components. Each interactive component, when the user acts on it (or speaks a matching decision), fires a `canvas_response({ component_id, value })` tool call back into the orchestrator's context. A separate `dismiss_canvas()` tool closes the panel. An escape hatch `render_canvas({ html })` renders arbitrary HTML in a sandboxed iframe for the long tail.

The schema is deliberately narrow — 7 components — so the orchestrator never agonizes over choice. Voice is the primary input channel; the Canvas exists to give the eyes something the ears cannot carry.

---

## Components

### 1. `moodboard`

**When to use:** Comparing 2–4 visual aesthetic directions before committing to a design system.

```ts
interface MoodboardProps {
  title?: string;                    // e.g. "Pick a direction for checkout"
  concepts: Array<{
    id: string;                      // "neon-gradient" | "flat-matte" | ...
    label: string;                   // "Neon Gradient"
    description: string;             // one-line aesthetic summary
    image_url: string;               // pre-generated reference image
    palette?: string[];              // optional hex swatches, max 6
  }>;                                // 2–4 items
}
```

**Visual:** A 2x1, 2x2, or 1x3 grid of large rounded image tiles with the label overlaid bottom-left and palette dots bottom-right. Hover (or voice selection) raises and brightens the chosen tile; others dim.

**Interactive:** Yes. Response: `{ value: { concept_id: string } }`. User can also speak "go with the right one" / "the matte one" — the orchestrator resolves to a concept_id.

**Example:**
```json
{
  "component": "moodboard",
  "component_id": "checkout-aesthetic-1",
  "props": {
    "title": "Checkout aesthetic",
    "concepts": [
      { "id": "neon", "label": "Neon Gradient", "description": "Vibrant, high-energy", "image_url": "...", "palette": ["#0FF", "#F0F"] },
      { "id": "matte", "label": "Flat Matte", "description": "Calm, premium, monochrome", "image_url": "...", "palette": ["#1A1A1A", "#EAEAEA"] }
    ]
  }
}
```

---

### 2. `options_picker`

**When to use:** Any branching decision with 2–6 discrete labeled choices (architectural fork, library choice, copywriting variants).

```ts
interface OptionsPickerProps {
  question: string;                  // "How should we handle auth?"
  context?: string;                  // optional sub-line / why-this-matters
  options: Array<{
    id: string;
    label: string;                   // short headline
    description?: string;            // 1–2 line tradeoff summary
    badge?: "recommended" | "fast" | "risky" | "cheap";
    icon?: string;                   // lucide icon name
  }>;                                // 2–6
  allow_multi?: boolean;             // default false
}
```

**Visual:** Vertically stacked frosted cards with large label, smaller description, optional badge pill, optional icon left. Selected card glows soft neon green.

**Interactive:** Yes. Response: `{ value: { option_ids: string[] } }` (always an array; single-select returns length 1).

---

### 3. `diagram`

**When to use:** Surfacing system architecture, data flow, or sequence of operations the agents are about to build — gives the user a chance to redirect before code is written.

```ts
interface DiagramProps {
  title?: string;
  mermaid: string;                   // raw mermaid source
  caption?: string;                  // one-line summary spoken aloud
  highlight_nodes?: string[];        // node IDs to pulse
}
```

**Visual:** Mermaid renders on a dark frosted background with soft glow on edges. Highlighted nodes pulse neon green. Caption sits below in muted text.

**Interactive:** No (display-only). User responds via voice; orchestrator decides whether to continue, edit, or re-render with a new mermaid string.

---

### 4. `code_preview`

**When to use:** Reviewing generated code, a proposed diff, or a config file before it's written to disk.

```ts
interface CodePreviewProps {
  title: string;                     // "src/checkout/CheckoutForm.tsx"
  language: string;                  // "tsx" | "python" | "sql" | ...
  code: string;                      // current/proposed content
  diff_against?: string;             // if present, render unified diff
  actions?: Array<"approve" | "reject" | "request_changes">;
  // default ["approve", "reject"] if interactive
}
```

**Visual:** Monospaced syntax-highlighted block on a near-black panel, filename header on top, line numbers gutter. Diff mode shows additions in green and removals in red against a darker base. Action buttons pinned bottom-right.

**Interactive:** Yes (if `actions` non-empty). Response: `{ value: { action: "approve" | "reject" | "request_changes", note?: string } }`.

---

### 5. `form`

**When to use:** Collecting structured input the agents are blocked on — API keys, env vars, config values, copy strings.

```ts
interface FormProps {
  title: string;                     // "Stripe staging keys needed"
  description?: string;
  fields: Array<{
    id: string;
    label: string;
    type: "text" | "password" | "url" | "email" | "number" | "textarea" | "toggle" | "select";
    placeholder?: string;
    required?: boolean;
    options?: Array<{ value: string; label: string }>;  // for select
    secret?: boolean;                // mask from logs / orchestrator transcript
  }>;
  submit_label?: string;             // default "Submit"
  allow_skip?: boolean;              // shows "Skip / mock it" button
}
```

**Visual:** Stacked floating-label inputs on glass, generous padding, single primary button bottom. Secret fields show a small lock icon and never echo to the voice transcript.

**Interactive:** Yes. Response: `{ value: { fields: Record<string, string | number | boolean>, skipped?: boolean } }`. Secret values are routed to env storage, not the orchestrator context — the orchestrator only sees `{ provided: true }` for those keys.

---

### 6. `agent_pod`

**When to use:** User asks "what's happening" or the orchestrator wants to make parallel work legible. Usually rendered in the always-visible Strip, but can be promoted to the Canvas for a fuller view.

```ts
interface AgentPodProps {
  agents: Array<{
    id: string;
    name: string;                    // "Frontend" | "Backend" | "Database"
    status: "idle" | "working" | "blocked" | "done" | "error";
    current_task?: string;           // micro-text trail
    progress?: number;               // 0–1, optional
    recent_files?: string[];         // last 3 paths touched
    blocker?: string;                // populated when status === "blocked"
  }>;
  show_logs?: boolean;               // expand a small streaming log area
}
```

**Visual:** A vertical column of nodes — each a small disc with a spinning gradient ring (green = working, amber = blocked, dim = idle, solid = done). Fading micro-text under each. Optional log drawer beneath.

**Interactive:** No (display-only / live-updating). User commands flow through voice. The component re-renders on every state-machine tick.

---

### 7. `artifact_preview`

**When to use:** Final artifact review — a compiled component, a rendered marketing page, an interactive sandbox the agents just built.

```ts
interface ArtifactPreviewProps {
  title: string;                     // "Checkout component"
  kind: "iframe" | "image" | "video";
  src: string;                       // URL or data URL
  viewport?: { width: number; height: number };  // for iframe
  actions?: Array<"ship" | "iterate" | "discard">;
  notes?: string;                    // orchestrator's spoken summary, mirrored visually
}
```

**Visual:** Large centered frame with subtle inner shadow. For `iframe`, a device-frame chrome with viewport selector pills (mobile/tablet/desktop). Action buttons bottom-right.

**Interactive:** Yes (if `actions` non-empty). Response: `{ value: { action: "ship" | "iterate" | "discard", note?: string } }`.

---

## Escape Hatch

`render_canvas({ html: string })` — renders arbitrary HTML in a sandboxed iframe with `sandbox="allow-scripts"` and a postMessage bridge that lets the inner doc emit `canvas_response`. For one-off cases that don't justify a new prebuilt component (e.g., a custom chart, a third-party embed).

---

## Lifecycle

- **Open:** `render_canvas(...)` slides the panel in (~280ms spring). If a canvas is already open, it cross-fades to the new content.
- **Close — interactive components:** auto-dismiss ~400ms after `canvas_response` fires, unless the orchestrator immediately re-renders.
- **Close — display-only components (`diagram`, `agent_pod`):** stay open until the orchestrator calls `dismiss_canvas()` or renders something else.
- **Close — user:** voice command ("dismiss", "close that") or `Esc` key → fires `canvas_response({ component_id, value: { dismissed: true } })` so the orchestrator knows.
- **Timeout:** none. The Canvas is a focus surface; let it sit.

---

## Response Routing

Every `render_canvas` call must include a `component_id` (orchestrator-generated, e.g. `checkout-aesthetic-1`). The Canvas runtime tags every emitted `canvas_response` with that ID. The orchestrator correlates response → original prompt by ID, which means the orchestrator can fire a `render_canvas` and continue working without blocking — the response arrives as a tool message when it arrives.

Voice responses ("go with the matte one") are resolved by the orchestrator itself: it sees the user's transcript plus the currently-active component's prop schema, picks the matching option_id, and synthesizes a `canvas_response` internally. The Canvas UI animates the selection so the user gets visual confirmation that voice was understood correctly.

---

## Stacking & Composition

Yes — `render_canvas` accepts an optional `layout` for stacked composition:

```ts
render_canvas({
  layout: "stack",                   // "stack" | "single" (default)
  components: [
    { component_id: "...", component: "moodboard", props: {...} },
    { component_id: "...", component: "options_picker", props: {...} }
  ]
})
```

Stacked components render vertically in the panel, each in its own glass card with a small gap. Each fires its own `canvas_response` independently. Capped at 3 stacked components — beyond that the panel feels like a form and we should use `form` instead.

The single-component form (`render_canvas({ component, props })`) is sugar for `layout: "single"` and is what the orchestrator should use 95% of the time.

---

## Open Questions

1. **Should the orchestrator be able to update a live component's props** (e.g., add a new agent to `agent_pod`) via `update_canvas({ component_id, props_patch })`, or do we always re-render? Re-render is simpler; patch is smoother.
2. **Secret handling in `form`** — are masked values stored in a local encrypted keychain, or piped straight to a `.env` file? Demo-wise, `.env` is faster; product-wise, keychain is correct.
3. **Voice-only fallback for `diagram`** — when no screen is visible (e.g., user is across the room), should the orchestrator narrate the diagram structure aloud? Probably yes for accessibility, but adds latency.
4. **`moodboard` image generation cost / latency** — pre-generate against a small library of aesthetic refs, or call DALL-E live? Live is more impressive in the demo but a 4–8s wait kills the "ambient" feel.
5. **Should `code_preview` support inline voice annotation** — user says "change line 14 to use async/await" and the Canvas highlights line 14? Powerful but probably v2.
6. **Multi-user / observer mode** — does the Canvas mirror to a second screen for pair-driving? Out of scope for the hackathon but informs the response-routing design now.
