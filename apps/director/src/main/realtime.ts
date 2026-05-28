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
  realtimeToolDefs,
  type RealtimeEphemeralToken,
  type RealtimeSessionRequest,
} from '../shared/realtime.js';

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets';

const DEFAULT_MODEL = 'gpt-realtime-2';
const DEFAULT_VOICE = 'marin';

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
        transcription: { model: 'gpt-4o-mini-transcribe' },
      },
      output: {
        // rate is REQUIRED at mint time; omission returns HTTP 400
        // ("Missing required parameter: session.audio.output.format.rate").
        format: { type: 'audio/pcm', rate: 24000 },
        voice: overrideVoice,
        speed: 1.0,
      },
    },
    tools: realtimeToolDefs(),
    tool_choice: 'auto',
    reasoning: { effort: 'low' as const },
    // Note: max_response_output_tokens is REJECTED by the GA mint endpoint
    // (HTTP 400 "Unknown parameter"). The server's own response uses
    // `max_output_tokens` (defaulting to "inf"); leaving it unset is fine.
    include: ['item.input_audio_transcription.logprobs'],
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
