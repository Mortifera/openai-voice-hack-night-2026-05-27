# Director — Vision

## 1. The Paradigm Shift

Director abandons the chatbot and copilot mental models. It is a native, ambient orchestration layer for **attended parallelization** and **harness engineering**.

In today's AI workflows the user is a typist: they write a prompt, wait synchronously for a stream of text, read the code, copy it, paste it. Director moves the user into the role of **manager** or **master carpenter**. The user dictates architectural constraints, approves visual direction, and resolves unhandled exceptions through natural voice. The underlying execution — boilerplate, dependencies, API wiring — is handled asynchronously by a fleet of specialized sub-agents.

The system rests on two pillars:

- **The Harness.** A living, automatically updating memory of architectural rules, past mistakes, and aesthetic preferences. When the user corrects an agent once, the entire system adopts that constraint permanently.
- **Proactive Orchestration.** The system does not wait idly for the next prompt. It executes until it hits a subjective judgment call or a fatal error, then proactively initiates a voice conversation to request a decision.

## 2. Vibe, Mood, Psychological Experience

The fundamental goal is to evoke a sense of **immense, invisible leverage**. The interface should feel like an extension of the user's cognition, not a separate tool they log into.

- **Visual language.** Minimalist and ambient. Borrows from macOS glassmorphism and the iOS dynamic island. No borders, no harsh lines, no cluttered dashboards. Deep translucency (backdrop blur), monochromatic base, sparse intentional status color — soft neon green for active execution, amber for blockers.
- **Motion and physics.** No linear animations. Everything is fluid, spring-based. When an agent spins up, its UI node expands smoothly from a central point. When the user interrupts the AI, the UI snaps to a listening state — hyper-responsive.
- **Sound design.** As important as the visuals. The orchestrator's voice is calm, concise, no conversational filler ("Sure, I can help with that" is banned). Subtle tactile chimes: a low soft tick when a sub-task completes; a distinct, slightly urgent double-tone when a proactive escalation needs attention.
- **The user emotion.** Unburdened from the mechanics of software engineering. The friction of syntax and tooling melts away, leaving only logic, taste, and system design.

## 3. Anatomy of the Interface

The UI operates on a spectrum of obtrusiveness — expanding only when necessary, collapsing back to the periphery when work resumes.

### State 1 — The Ambient Strip

Idle, or when agents are working without blockers. A slender vertical floating bar, 20px off the right edge of the screen. Heavily blurred, desktop wallpaper showing through. A slow-pulsing waveform indicates the system is listening for its wake-word or hotkey.

### State 2 — The Agent Hive

When work is dispatched, the Strip expands to reveal the Pod: a vertical list of abstract nodes, one per sub-agent (Frontend, Database, API, etc.).

- Each node has a fluid continuous motion indicator (spinning gradient ring) to show active work.
- Tiny fading text trails beneath each node show the micro-tasks executing in real time — *"Configuring JWT..."* fading into *"Writing user schema..."*. Massive labor is visibly occurring without forcing the user to read code.

### State 3 — The GenUI Canvas

When the Orchestrator needs a visual judgment (moodboards, architecture diagrams, compiled web components), a wide frosted-glass panel slides out from the Strip and overlays the right half of the desktop. It casts a soft drop-shadow over underlying windows, pulling total focus to the rendered artifact.

## 4. Execution Flow — Frame by Frame

### Phase 1 — Ambient Context Retrieval
The interaction begins with environment awareness, not a blank prompt. User holds a hotkey; the Strip's waveform brightens.

> **User:** "I'm ready to start. What's the next ticket?"
> **Orchestrator:** "Priority one is the new checkout flow. I can dispatch the team, but we lack a visual aesthetic for this component. Shall we define one?"
> **User:** "Yes. Generate a visual moodboard. Make it minimalist, SaaS, dark mode palette."

### Phase 2 — Visual Judgment & The Canvas State
The Strip expands outward, deploying the GenUI Canvas. High-resolution aesthetic concepts materialize inside. The screen behind the canvas dims slightly.

> **Orchestrator:** "I have two concepts. The left uses heavy neon gradients. The right utilizes flat matte surfaces."

### Phase 3 — Course Correction and Barge-In
The user decides and speaks over the AI.

> **User (interrupting):** "Stop. Go with the right. Also, update the system rules: all future UI components must use this flat matte aesthetic. No gradients."

The instant the user's voice crosses a decibel threshold, the Orchestrator cuts out cleanly. The waveform on the Strip spikes to acknowledge the interruption.

> **Orchestrator:** "Understood. I have updated the project harness to permanently enforce flat matte UI. Dispatching the engineering pod to build the checkout flow based on this aesthetic."

A subtle checkmark animation pulses on the Strip, confirming the rule has been saved to the Harness.

### Phase 4 — Attended Parallelization
The Canvas slides away. The Strip stays, now in Agent Hive view. Three nodes — Frontend, Backend, Database — spin with green gradient rings. Micro-text cascades beneath them. The user is free to check email or read a document while the system builds.

### Phase 5 — Proactive Escalation (Systems-to-Voice)
Two minutes later, execution hits a wall. Polite but impossible to miss.

A gentle dual-tone chime plays. The Backend node's spinning green ring snaps to pulsing amber. The Strip subtly bounces to catch the user's peripheral vision.

> **Orchestrator (unprompted):** "Grabbing your attention. The backend agent is blocked. We are missing the Stripe staging API keys in the environment variables. Would you like to provide them now, or should I instruct the agent to mock the payment gateway so the frontend can finish integration?"
> **User:** "Just mock the gateway for now. We'll add the keys later."
> **Orchestrator:** "Instruction routed. Backend unblocked."

The amber node turns green again. Micro-text updates to *"Injecting mock gateway..."*. Execution continues.

### Phase 6 — The Final Artifact
A final chime. All agent nodes transition to a solid, calm state.

> **Orchestrator:** "The checkout component is compiled and ready for review."

The Canvas slides out one last time. Instead of an image it contains a fully rendered, interactive React environment. The user clicks the buttons, hovers the inputs, and visually verifies the multi-agent pod's output on their desktop — before ever opening a pull request.

## 5. Architectural Paradigms (Conceptual)

Voice, visuals, and execution are completely decoupled layers communicating through a central nervous system.

- **The Orchestrator is a router, not a worker.** The voice model is optimized strictly for speed, conversational naturalness, and intent routing. It does not write code. It translates spoken words into systemic commands and updates the central state.
- **The Central State Machine.** The source of truth for the entire UI. The UI does not listen to agents directly — it purely reflects the State Machine. An agent error flags the State Machine; the State Machine updates status to *blocked*; that simultaneously turns the UI node amber and triggers the Voice Orchestrator to surface the issue.
- **Sandboxed asynchronous execution.** The coding models (sub-agents) live in an isolated environment, running in continuous loops — reading the architecture plan, writing files, running local tests. Because they are decoupled from the Voice layer, a sub-agent taking 60 seconds to resolve a dependency tree never causes the Voice UI to hang.
- **Dynamic component rendering.** The GenUI system lets the State Machine pass raw strings of code (HTML, Mermaid.js, image URLs) directly to the isolated Canvas container. The system shifts instantly from simple audio interface to rich visual dashboard, driven purely by the work in flight.

## 6. North Star

You feel the friction of syntax and tooling melt away. What remains is logic, taste, and system design — spoken aloud, executed in parallel, surfaced only when you are needed.
