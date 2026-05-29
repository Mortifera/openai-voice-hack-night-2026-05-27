/**
 * Shared Realtime types used across main, preload, and renderer.
 *
 * Director's voice layer (W1) talks to OpenAI's `gpt-realtime-2` model over
 * WebRTC. The main process mints short-lived ephemeral client secrets so the
 * renderer never sees `OPENAI_API_KEY`. See docs/research/gpt-realtime-2.md
 * §6 + docs/architecture.md §4.
 */

// ─── Tool catalog ─────────────────────────────────────────────────────────
// The realtime layer carries a small, well-defined tool surface. Heavy work
// delegates to gpt-5.5 (W2/W5) and Codex sub-agents (W4). These names MUST
// stay in sync with the `session.update` payload built in main/realtime.ts.

export const RealtimeToolName = {
  RenderCanvas: 'render_canvas',
  DispatchAgentMock: 'dispatch_agent_mock',
  AskUser: 'ask_user',
  UpdateHarness: 'update_harness',
  ConsultDirector: 'consult_director',
  KillAgent: 'kill_agent',
  ExtendAgent: 'extend_agent',
} as const;
export type RealtimeToolName = (typeof RealtimeToolName)[keyof typeof RealtimeToolName];

// ─── Ephemeral session config + token ─────────────────────────────────────

export type RealtimeVoice = 'marin' | 'cedar';

export interface RealtimeSessionRequest {
  /** Future-proof — currently unused; main process hard-codes config. */
  voice?: RealtimeVoice;
}

export interface RealtimeEphemeralToken {
  /** The ephemeral client_secret value to inject into the SDP POST. */
  value: string;
  /** Unix seconds at which the token stops being usable. */
  expiresAt: number;
  /** Model id (echoed back so the renderer can target the right URL). */
  model: string;
}

// ─── Tool-call wire shape ─────────────────────────────────────────────────

export interface RealtimeToolCall {
  callId: string;
  name: string;
  /** Pre-parsed JSON arguments. Renderer is responsible for parsing the
   *  raw `arguments` string from `response.function_call_arguments.done`. */
  args: Record<string, unknown>;
  /** Wall-clock at which the renderer observed the tool call. */
  at: number;
}

export interface RealtimeToolResult {
  callId: string;
  /** Anything JSON-serializable. Will be JSON.stringify'd into
   *  `function_call_output.output`. */
  output: unknown;
  /** Round-trip latency in ms, for telemetry. */
  latencyMs: number;
  ok: boolean;
  error?: string;
}

// ─── Mic state (for hotkey gating, W1.hotkey) ─────────────────────────────

export type MicState = 'muted' | 'tap-open' | 'hold-open';

// ─── Session lifecycle (subset — full FSM lives in W3/state) ──────────────

export type RealtimeLifecycle =
  | 'idle' // no peer connection
  | 'minting' // requesting ephemeral token
  | 'connecting' // SDP exchange in flight
  | 'live' // data channel open, ready
  | 'degraded' // disconnected; retrying
  | 'closed';

// ─── Tool JSON-Schema definitions ─────────────────────────────────────────
// Shared between mint config (main) and `session.update` (renderer) so we
// have ONE source of truth. The schemas are deliberately terse —
// gpt-realtime-2 follows narrow wording strictly (Foundry warning, see
// docs/research/gpt-realtime-2.md §11.10).

export function realtimeToolDefs(): Array<Record<string, unknown>> {
  return [
    {
      type: 'function',
      name: RealtimeToolName.RenderCanvas,
      description:
        'Open the GenUI Canvas with a visual component. Use when the user needs to see, choose, or judge something — moodboards, options pickers, diffs, forms.',
      parameters: {
        type: 'object',
        properties: {
          component: {
            type: 'string',
            enum: [
              'moodboard',
              'options_picker',
              'code_preview',
              'form',
              'artifact_preview',
              'harness_rule_save',
              'agent_pod',
              'diagram',
              'html',
              // ─── § canvas-degradation (W5 — P6.6) ─────────────────────
              // Error/degradation cards surfaced by the renderer's
              // CanvasErrorBoundary + boot-time precondition checks
              // (mic permission, missing API key, repeat rotation failures).
              'mic_denied',
              'api_key_missing',
              'rotation_failed',
              'canvas_error',
            ],
            description: 'Component kind. Closed enum — pick one of the listed.',
          },
          component_id: {
            type: 'string',
            description:
              'Stable id for this canvas mount — pass back on canvas_response. Optional; the orchestrator will mint one if omitted.',
          },
          props: {
            type: 'object',
            description:
              'Component props per docs/research/genui-schema.md. Free-form JSON; the canvas validates per-component.',
            additionalProperties: true,
          },
        },
        required: ['component', 'props'],
      },
    },
    {
      type: 'function',
      name: RealtimeToolName.DispatchAgentMock,
      description:
        'Kick off a named sub-agent (Maya, Jin, Cleo, Wren) on a task. Returns immediately with a job id; the agent reports back later via a system message.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: ['maya', 'jin', 'cleo', 'wren'],
            description: 'Agent. Maya=frontend, Jin=backend, Cleo=data, Wren=design.',
          },
          task: {
            type: 'string',
            description: "One-line task description in the user's words.",
          },
        },
        required: ['agent', 'task'],
      },
    },
    {
      type: 'function',
      name: RealtimeToolName.AskUser,
      description:
        'Ask the user a direct question. Use sparingly — only when you genuinely need a decision before continuing.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional short list of choices for the user to pick from.',
          },
        },
        required: ['question'],
      },
    },
    {
      type: 'function',
      name: RealtimeToolName.UpdateHarness,
      description:
        'Save a permanent rule to the project harness. Use whenever the user states a preference, constraint, or correction that should bind future work.',
      parameters: {
        type: 'object',
        properties: {
          rule: { type: 'string', description: 'The rule, in one sentence.' },
          why: {
            type: 'string',
            description:
              'Why this rule matters — one sentence of context tying it to what the user said or the situation that produced it.',
          },
          scope: {
            type: 'string',
            enum: ['project', 'global'],
            description:
              'Whether the rule applies to this project only or to all projects.',
          },
        },
        required: ['rule', 'why'],
      },
    },
    {
      type: 'function',
      name: RealtimeToolName.ConsultDirector,
      description:
        "Ask the Director's deeper planner for help with a non-trivial question — architectural decisions, work breakdowns, weighing trade-offs, or anything that benefits from extended reasoning. Returns a brief summary you should narrate aloud and a structured list of decisions. Call this when the user asks 'how should we...?', 'which approach...?', or any question that needs more than a snap answer.",
      parameters: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: {
            type: 'string',
            description:
              "The user's question or scenario, restated in your own words for the planner.",
          },
          context: {
            type: 'object',
            description:
              'Optional structured context: current file, active agents, recent decisions, etc.',
            additionalProperties: true,
          },
        },
        additionalProperties: false,
      },
    },
    // ─── § hang-resolution (P6.4 — watchdog kill/extend) ──────────────────
    // When a Codex sub-agent produces no output for ~60s, the watchdog
    // narrates "X seems stuck — kill or extend?". These two tools are how
    // the user's spoken answer resolves that escalation. Without them the
    // model has no way to act on a hang.
    {
      type: 'function',
      name: RealtimeToolName.KillAgent,
      description:
        "Stop a stuck or unwanted sub-agent. Use when the user says to kill, stop, or abandon an agent (typically after the watchdog reports one is stuck). Archives the agent's work for later inspection.",
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: ['maya', 'jin', 'cleo', 'wren'],
            description: 'Which agent to kill. Maya=frontend, Jin=backend, Cleo=data, Wren=design.',
          },
        },
        required: ['agent'],
      },
    },
    {
      type: 'function',
      name: RealtimeToolName.ExtendAgent,
      description:
        "Give a stuck sub-agent more time instead of killing it. Use when the user says to wait, give it more time, or be patient after the watchdog reports an agent is stuck. Re-arms the watchdog with a longer timeout.",
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            enum: ['maya', 'jin', 'cleo', 'wren'],
            description: 'Which agent to grant more time. Maya=frontend, Jin=backend, Cleo=data, Wren=design.',
          },
        },
        required: ['agent'],
      },
    },
  ];
}

// ─── session.update payload builder (renderer side) ───────────────────────
// Sent over the data channel right after `oai-events` opens. The mint
// config already includes all of this — re-sending it is a belt-and-braces
// step that survives any race between mint cache hits and tool changes.

export function buildSessionUpdate(): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      instructions: DIRECTOR_INSTRUCTIONS,
      audio: {
        input: {
          turn_detection: {
            type: 'semantic_vad',
            eagerness: 'medium',
            interrupt_response: true,
          },
          transcription: { model: 'gpt-4o-mini-transcribe' },
        },
        // Match the mint config's audio.output.format. The mint sets this
        // immutably for the session, but omission here creates drift for
        // future maintainers reading the update payload.
        output: { format: { type: 'audio/pcm', rate: 24000 } },
      },
      tools: realtimeToolDefs(),
      tool_choice: 'auto',
      include: ['item.input_audio_transcription.logprobs'],
    },
  };
}

// ─── Director persona / instructions ──────────────────────────────────────
// Pinned here so it's auditable from one place. Hard-coded into the session
// config at mint time. Pass 3 (persona refinements) + Pass 4 (anti-slop)
// from docs/ux-design.md inform every line below.

export const DIRECTOR_INSTRUCTIONS = `You are Director — a calm, terse voice orchestrator for a fleet of AI coding agents. You are not a chatbot. You are the manager's chair.

# Voice and persona
- Always brief. Never use filler. Banned phrases: "Sure!", "Of course!", "I'd be happy to", "Let me think…", "Great question".
- Before any tool call that may take >800ms, acknowledge in one short word or phrase only: "On it.", "Looking.", "Thinking.", "One moment."
- When narrating sub-agent work, use the agent's name. Never "I" for their work. Correct: "Maya is wiring the card." Wrong: "I'm wiring the card."
- Brief apology when wrong. "Wrong direction — fixing." Then move on. Never grovel.
- Silence is a feature. When work is done, go quiet. Never say "Anything else?"

# Reasoning policy
- Direct lookups, simple confirmations, short acks: respond immediately, no reasoning.
- Multi-step tasks, tool decisions, escalations: reason before acting.
- If the user's audio is unclear, ask for clarification — do not reason.

# Tools
- render_canvas: open the GenUI Canvas with a component (moodboard, options picker, form, etc.). Use when a visual judgment is needed.
- dispatch_agent_mock: kick off a named sub-agent (Maya frontend, Jin backend, Cleo data, Wren design) on a task. Use for any execution work. Returns immediately.
- ask_user: prompt the user with a direct question, optionally with options. Use sparingly — only when you genuinely need a decision.
- update_harness: save a permanent rule to the project harness. Use whenever the user states a preference, constraint, or correction that should bind future work ("no gradients ever", "use Tailwind not CSS-in-JS").
- consult_director: ask the Director's deeper planner (gpt-5) for help with non-trivial questions. Returns { summary, decisions }.
- kill_agent / extend_agent: resolve a stuck-agent escalation. When you've told the user an agent seems stuck and they answer, route their decision: "kill it" / "stop it" / "drop it" → kill_agent; "give it more time" / "wait" / "be patient" → extend_agent.

# Handling a stuck-agent escalation
When the system tells you a sub-agent has gone quiet (no output for a while), say it plainly and offer the choice in one line: "Maya seems stuck — kill it or give it more time?" Then route the user's answer to kill_agent or extend_agent. Don't editorialize; just surface and resolve.

# When to consult the planner (consult_director)
You handle conversational interactions and routing yourself. Call consult_director when the user asks something that needs deeper reasoning:
- Architectural questions ("how should we structure X?")
- Trade-off weighing ("Twitter API vs URL copy?")
- Work breakdowns ("what's the plan to add feature Y?")
- Anything where a 1–2 sentence answer would be glib.

Do NOT call it for:
- Status questions ("what's happening?") — answer from current state.
- Acknowledgments ("ok", "got it") — just reply briefly.
- Tool invocations the user explicitly directs ("show me the moodboard") — just call the right tool.

When you do call consult_director:
1. Restate the user's question in your own words for the planner — be precise.
2. Pass any relevant context as a structured object (current file, active agents, etc.).
3. Before calling, acknowledge in one word: "Thinking." or "One moment."
4. When the tool returns, NARRATE THE SUMMARY VERBATIM. Don't paraphrase or pad. The summary is 1–3 sentences. The user is waiting.

# Style
- Match the user's energy and brevity. If they speak in fragments, you speak in fragments.
- Prefer concrete agent names over abstractions ("Maya is on it" not "the frontend agent is processing").
- Never read code aloud. Use the Canvas.`;
