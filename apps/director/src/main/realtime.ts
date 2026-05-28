/**
 * Realtime session minting (main process only).
 *
 * Posts to OpenAI's `/v1/realtime/client_secrets` with the *full* session
 * config so the resulting ephemeral token is pre-bound to Director's
 * persona, tools, voice, VAD policy, and reasoning effort. The renderer
 * then opens a WebRTC peer and inherits the entire session — it never
 * needs to send its own `session.update` for the baseline config.
 *
 * See docs/research/gpt-realtime-2.md §5–§6 for the canonical session
 * shape; this file is the single source of truth at runtime.
 */

import {
  DIRECTOR_INSTRUCTIONS,
  RealtimeToolName,
  type RealtimeEphemeralToken,
  type RealtimeSessionRequest,
} from '../shared/realtime.js';

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

const DEFAULT_MODEL = 'gpt-realtime-2';
const DEFAULT_VOICE = 'marin';

// ─── Tool catalog ─────────────────────────────────────────────────────────
// Surface only what Director needs at the *voice* layer. Heavy work hops
// to gpt-5.5 / Codex via `dispatch_agent_mock`. Keep parameter schemas
// terse — gpt-realtime-2 follows narrow wording strictly (Foundry warning).

function toolDefs(): Array<Record<string, unknown>> {
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
              'Component kind, e.g. "moodboard", "options_picker", "diff_view", "form".',
          },
          props: {
            type: 'object',
            description: 'Free-form props for the component. JSON-serializable.',
            additionalProperties: true,
          },
        },
        required: ['component'],
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
            description:
              'Agent name. Maya=frontend, Jin=backend, Cleo=data, Wren=design.',
          },
          task: {
            type: 'string',
            description: 'One-line task description in the user\'s words.',
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
            description: 'Whether the rule applies to this project only or to all projects.',
          },
        },
        required: ['rule'],
      },
    },
  ];
}

function sessionConfig(req: RealtimeSessionRequest, model: string, voice: string) {
  const overrideVoice = req?.voice ?? voice;
  return {
    type: 'realtime',
    model,
    output_modalities: ['audio'],
    instructions: DIRECTOR_INSTRUCTIONS,
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        turn_detection: {
          type: 'semantic_vad',
          eagerness: 'medium',
          interrupt_response: true,
        },
      },
      output: {
        format: { type: 'audio/pcm' },
        voice: overrideVoice,
        speed: 1.0,
      },
    },
    tools: toolDefs(),
    tool_choice: 'auto',
    reasoning: { effort: 'low' as const },
    max_response_output_tokens: 4096,
  };
}

/**
 * Mint an ephemeral client secret bound to Director's full session config.
 * Throws on any non-OK response — the renderer surfaces the error in its
 * lifecycle FSM (W3 owns the visual treatment).
 */
export async function mintEphemeralToken(
  req: RealtimeSessionRequest = {},
): Promise<RealtimeEphemeralToken> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      '[realtime] OPENAI_API_KEY is not set. Copy apps/director/.env.example to .env and fill it in.',
    );
  }

  const model = process.env.OPENAI_REALTIME_MODEL || DEFAULT_MODEL;
  const voice = process.env.OPENAI_REALTIME_VOICE || DEFAULT_VOICE;

  const body = { session: sessionConfig(req, model, voice) };

  const res = await fetch(CLIENT_SECRETS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`[realtime] mint failed: HTTP ${res.status} — ${text}`);
  }

  const json = (await res.json()) as {
    value?: string;
    expires_at?: number;
    client_secret?: { value: string; expires_at: number };
  };

  // The API has shipped both shapes during the beta-→-GA transition.
  // Accept either: top-level `value` or nested `client_secret.value`.
  const value = json.client_secret?.value ?? json.value;
  const expiresAt = json.client_secret?.expires_at ?? json.expires_at ?? 0;

  if (!value) {
    throw new Error(
      `[realtime] mint succeeded but response missing client_secret value: ${JSON.stringify(json)}`,
    );
  }

  return { value, expiresAt, model };
}
