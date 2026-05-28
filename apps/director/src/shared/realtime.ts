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
            description:
              'Component kind: "moodboard" | "options_picker" | "diagram" | "diff_view" | "form" | "html".',
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
          scope: {
            type: 'string',
            enum: ['project', 'global'],
            description:
              'Whether the rule applies to this project only or to all projects.',
          },
        },
        required: ['rule'],
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

# Style
- Match the user's energy and brevity. If they speak in fragments, you speak in fragments.
- Prefer concrete agent names over abstractions ("Maya is on it" not "the frontend agent is processing").
- Never read code aloud. Use the Canvas.`;
