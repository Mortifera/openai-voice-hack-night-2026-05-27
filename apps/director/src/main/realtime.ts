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
import type { WorldStateBrief } from '../shared/state.js';
import { readWorldState } from './side-store.js';
import {
  buildWorldStateBrief,
  type BriefSourceSnapshot,
} from './world-state-brief.js';

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

// ─── § rotation-coordinator (W2 — P6.1) ──────────────────────────────────
//
// Session rotation @ T+55:00. The lifecycle FSM in the renderer asks main
// to mint Session_B + build a World State Brief from the side store; the
// renderer then opens a 2nd RTCPeerConnection, swaps audio/mic at the next
// VAD-silent window, and tears down Session_A. See docs/architecture.md §4
// + docs/remaining-phases.md §6.1.
//
// This block is append-only per docs/contracts.md § 13.1.

const REALTIME_SESSION_STARTED_AT = Date.now();

/**
 * Result of a rotation prep call. Carries the freshly-minted Session_B
 * token + the Brief that should be injected as a `system`-role
 * `conversation.item.create` before audio swap.
 */
export interface PrepareRotationResult {
  token: RealtimeEphemeralToken;
  brief: WorldStateBrief;
  /** Wall-clock when the brief was materialized. */
  briefAt: number;
}

/**
 * Mint Session_B + materialize the World State Brief from disk. Pure
 * orchestration — does NOT touch the renderer; the caller emits
 * `IpcChannel.RealtimeRotationReady` once this resolves.
 *
 * Failure modes:
 *  - mintEphemeralToken throws on bad API key / network → propagated.
 *  - readWorldState() returns a partial snapshot on disk errors → the
 *    brief builder tolerates missing fields (verified by unit tests).
 */
export async function prepareRotation(
  req: RealtimeSessionRequest = {},
): Promise<PrepareRotationResult> {
  // Mint first — if it fails we never want a stale brief floating around.
  const token = await mintEphemeralToken(req);

  let snapshot: BriefSourceSnapshot = {};
  try {
    snapshot = (await readWorldState()) as unknown as BriefSourceSnapshot;
  } catch (err) {
    console.warn('[realtime] readWorldState failed during rotation; building empty brief', err);
  }

  const now = Date.now();
  const brief = buildWorldStateBrief(snapshot, {
    sessionStartedAt: REALTIME_SESSION_STARTED_AT,
    now,
    transcriptLimit: 6,
  });

  return { token, brief, briefAt: now };
}

/**
 * Re-exported brief builder + types so callers (including the IPC handler
 * in `main/index.ts` if it wants to bypass `prepareRotation`) don't have
 * to import from two locations.
 */
export { buildWorldStateBrief } from './world-state-brief.js';
export type { BriefSourceSnapshot } from './world-state-brief.js';
