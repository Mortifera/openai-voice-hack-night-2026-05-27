/**
 * Compaction runner — decides WHEN to compact and EXECUTES the compaction
 * round-trip against the Responses API.
 *
 * Two pure-ish surfaces:
 *
 *   - `shouldCompact(stats, opts)` — pure decision function. Inputs are
 *     usage / activity counters; output is a `{ fire, reason }` verdict.
 *     Used by the planner at quiescent moments to decide whether to fire
 *     a manual `responses.compact`. Three trigger conditions per
 *     docs/remaining-phases.md § 7.2:
 *       1. cumulative-tool — >50k tokens of tool output since the last
 *          compaction (Codex diffs + stack traces can be huge).
 *       2. idle-large — user idle ≥ 90s AND >80k tokens in flight.
 *       3. pre-rotation — explicit precondition for session rotation
 *          (caller passes `opts.preRotation = true`).
 *
 *   - `runCompaction(client, lastResponseId)` — invokes the standalone
 *     `responses.compact` endpoint (per `docs/research/compaction.md` § 1b).
 *     Designed to be non-blocking: caller awaits the promise, but the
 *     planner only queues the next consult behind a settled compaction.
 *
 *     Graceful fallback: if `client.responses.compact` doesn't exist on
 *     the installed SDK version, we fall back to a direct fetch against
 *     `/v1/responses/compact`. If THAT 404s (endpoint not in this
 *     account's API surface yet), we log a warning and return a noop
 *     result — the `context_management` safety net on every
 *     `responses.create` keeps the orchestrator alive in that case.
 *
 * Both surfaces are testable without Electron, fetch, or fs. The planner
 * is the only consumer.
 */

import type OpenAI from 'openai';
import {
  appendOrchestratorEntry,
  type WorldState,
} from './side-store.js';

// ─── shouldCompact ─────────────────────────────────────────────────────

/**
 * Numeric/temporal counters the planner mirrors as it runs. All fields
 * are tolerant of out-of-band values — clamps to 0 if missing.
 *
 *   cumulativeToolTokens     — sum of `usage.output_tokens` across every
 *                              tool-call round-trip since the last
 *                              compaction landed.
 *   tokensSinceLastCompaction — total tokens in the orchestrator's
 *                              compactable window (assistant + tool +
 *                              reasoning). User messages are kept by
 *                              compaction, so they're tracked but not
 *                              the primary signal.
 *   lastUserActivityAt       — ms epoch of the last user utterance, used
 *                              to detect quiescent idle moments.
 *   nowMs                    — caller-provided `Date.now()`. Injectable
 *                              so unit tests don't depend on clock skew.
 */
export interface CompactionStats {
  cumulativeToolTokens: number;
  tokensSinceLastCompaction: number;
  lastUserActivityAt: number;
  nowMs: number;
}

export type ShouldCompactReasonName =
  | 'cumulative-tool'
  | 'idle-large'
  | 'pre-rotation';

export interface ShouldCompactReason {
  fire: boolean;
  reason?: ShouldCompactReasonName;
}

export interface ShouldCompactOptions {
  /** ms; defaults to 90_000. Idle-large trigger requires being idle this long. */
  idleThresholdMs?: number;
  /** Caller asserts a session rotation is imminent — short-circuit fire. */
  preRotation?: boolean;
}

/** Threshold in tokens for the cumulative-tool trigger. */
export const CUMULATIVE_TOOL_TRIGGER_TOKENS = 50_000;
/** Threshold in tokens for the idle-large trigger. */
export const IDLE_LARGE_TRIGGER_TOKENS = 80_000;
/** Default idle window (ms) for the idle-large trigger. */
export const DEFAULT_IDLE_THRESHOLD_MS = 90_000;

function clampNonNegative(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n;
}

/**
 * Pure decision: should we fire a manual compaction NOW?
 *
 * Precedence (highest wins):
 *   1. pre-rotation (caller-asserted, can't be overridden)
 *   2. cumulative-tool (>50k tokens of tool output)
 *   3. idle-large (idle ≥ idleThreshold AND >80k tokens)
 *
 * Returns `{ fire: false }` if none of the conditions hit. Defensive: any
 * out-of-band field falls back to 0, so a corrupt stats object can't
 * spuriously fire.
 */
export function shouldCompact(
  stats: CompactionStats,
  opts?: ShouldCompactOptions,
): ShouldCompactReason {
  const idleThresholdMs = Math.max(
    0,
    opts?.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS,
  );

  if (opts?.preRotation === true) {
    return { fire: true, reason: 'pre-rotation' };
  }

  const cumulativeToolTokens = clampNonNegative(stats?.cumulativeToolTokens);
  if (cumulativeToolTokens > CUMULATIVE_TOOL_TRIGGER_TOKENS) {
    return { fire: true, reason: 'cumulative-tool' };
  }

  const tokensSinceLastCompaction = clampNonNegative(
    stats?.tokensSinceLastCompaction,
  );
  const lastUserActivityAt = clampNonNegative(stats?.lastUserActivityAt);
  const nowMs = clampNonNegative(stats?.nowMs);
  const idleMs = lastUserActivityAt > 0 ? nowMs - lastUserActivityAt : 0;
  if (
    idleMs >= idleThresholdMs &&
    tokensSinceLastCompaction > IDLE_LARGE_TRIGGER_TOKENS
  ) {
    return { fire: true, reason: 'idle-large' };
  }

  return { fire: false };
}

// ─── runCompaction ─────────────────────────────────────────────────────

const RESPONSES_COMPACT_URL = 'https://api.openai.com/v1/responses/compact';
const COMPACTION_MODEL = 'gpt-5';

export interface CompactionUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  /** Future-proof: forward any extra usage fields the API ships. */
  [key: string]: unknown;
}

export interface CompactionResult {
  /** New `response.id` after compaction. `null` if the endpoint was a noop. */
  newResponseId: string | null;
  /** Usage payload from the compaction call, if returned. */
  usage: CompactionUsage | null;
  /** True if the SDK / endpoint reported success. */
  ok: boolean;
  /** Set when we fell back / no-op'd; a hint for the caller's log line. */
  fallback?: 'sdk-missing' | 'endpoint-missing' | 'request-failed';
  /** Human-readable detail for diagnostic logging. */
  detail?: string;
}

/**
 * Loose duck-typed shape for the OpenAI SDK's `responses.compact` method.
 * The runtime check below probes for this shape; the static type is
 * deliberately permissive so older SDK versions still compile.
 */
interface CompactionCapableSDK {
  responses?: {
    compact?: (params: {
      model: string;
      previous_response_id: string;
      store?: boolean;
    }) => Promise<{
      id?: string;
      usage?: CompactionUsage;
      [key: string]: unknown;
    }>;
  };
  apiKey?: string;
}

/**
 * Execute a compaction round-trip. Returns the new response id (the
 * planner uses it as the next `previous_response_id`) plus usage stats.
 *
 * Fallback chain:
 *   1. `client.responses.compact(...)` — preferred (SDK type-safe).
 *   2. Direct fetch against `/v1/responses/compact` — handles SDK lag.
 *   3. No-op with `ok: false, fallback: 'endpoint-missing'` — safety net
 *      already covered by `context_management` on every `responses.create`.
 *
 * NEVER throws — every failure surface returns a structured result. The
 * planner uses `result.ok` to decide whether to advance the chain.
 */
export async function runCompaction(
  client: OpenAI,
  lastResponseId: string,
): Promise<CompactionResult> {
  if (!lastResponseId || typeof lastResponseId !== 'string') {
    return {
      newResponseId: null,
      usage: null,
      ok: false,
      fallback: 'request-failed',
      detail: 'lastResponseId missing',
    };
  }

  // 1. Try the SDK first if the method exists. The Feb 2026 compaction API
  //    landed mid-flight; older SDK versions don't carry the typing.
  const sdk = client as unknown as CompactionCapableSDK;
  const compactFn = sdk.responses?.compact;
  if (typeof compactFn === 'function') {
    try {
      const resp = await compactFn.call(sdk.responses, {
        model: COMPACTION_MODEL,
        previous_response_id: lastResponseId,
        store: false,
      });
      return {
        newResponseId:
          typeof resp?.id === 'string' && resp.id.length > 0 ? resp.id : null,
        usage: (resp?.usage as CompactionUsage | undefined) ?? null,
        ok: true,
      };
    } catch (err) {
      // Fall through to the fetch fallback — the SDK may have shipped the
      // type but the runtime endpoint may still be inaccessible.
      console.warn(
        '[compaction-runner] SDK responses.compact failed; trying fetch fallback',
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 2. Fetch fallback. Uses the same env-var auth path as the planner.
  const apiKey = process.env.OPENAI_API_KEY ?? sdk.apiKey;
  if (!apiKey || typeof apiKey !== 'string') {
    return {
      newResponseId: null,
      usage: null,
      ok: false,
      fallback: 'request-failed',
      detail: 'OPENAI_API_KEY missing',
    };
  }

  try {
    const resp = await fetch(RESPONSES_COMPACT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: COMPACTION_MODEL,
        previous_response_id: lastResponseId,
        store: false,
      }),
    });

    if (resp.status === 404) {
      console.warn(
        '[compaction-runner] /v1/responses/compact returned 404 — endpoint not available on this account; relying on context_management safety net',
      );
      return {
        newResponseId: null,
        usage: null,
        ok: false,
        fallback: 'endpoint-missing',
        detail: '404 from /v1/responses/compact',
      };
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '<no body>');
      return {
        newResponseId: null,
        usage: null,
        ok: false,
        fallback: 'request-failed',
        detail: `${resp.status}: ${errText.slice(0, 240)}`,
      };
    }

    const json = (await resp.json().catch(() => null)) as {
      id?: string;
      usage?: CompactionUsage;
    } | null;
    return {
      newResponseId:
        typeof json?.id === 'string' && json.id.length > 0 ? json.id : null,
      usage: json?.usage ?? null,
      ok: true,
    };
  } catch (err) {
    return {
      newResponseId: null,
      usage: null,
      ok: false,
      fallback: 'request-failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── § health-check-probe (Main — P7.3) ────────────────────────────────
// Append-only marker per docs/contracts.md § 13.1. This block adds the
// post-compaction health-check probe.
//
// After a compaction lands, the planner's encrypted context blob is
// opaque — we can't directly verify it preserved the must-know facts
// (current goal, active agents, most recent user turn). The probe fires
// a synthetic single-turn `responses.create` against a cheap model
// asking the planner to recite those facts WITHOUT calling tools, then
// cross-checks the answer against the side-store world state. On
// mismatch, the planner (caller) prepends a fresh system message to the
// next consult containing the must-preserve blocks.
//
// Failure modes (probe call 5xx, timeout, parse error) are non-fatal:
// the planner instructions are rebuilt from side-store on every consult
// anyway, so a missed probe just means we lose ONE re-injection signal
// — user-visible state stays correct.

const HEALTH_PROBE_MODEL_PRIMARY = 'gpt-5-mini';
const HEALTH_PROBE_MODEL_FALLBACK = 'gpt-5';
const HEALTH_PROBE_PROMPT =
  'Without using tools, in 3 lines: what is the current goal, what agents are active, what was the most recent user instruction?';

/** Subset of the world-state the probe disagreed about. Any combination of
 *  fields may be set; an absent field means "the probe matched that one". */
export interface ProbeMismatch {
  goal?: string;
  agents?: string[];
  lastUser?: string;
}

/** Result of a single probe round-trip. `ok:true` means either an exact
 *  cross-check pass OR a non-fatal failure (5xx, parse error, timeout) —
 *  the planner treats both as "no re-injection needed". On mismatch,
 *  `ok:false` AND `mismatch` carries the must-preserve facts. */
export interface ProbeResult {
  ok: boolean;
  mismatch?: ProbeMismatch;
}

/** Loose duck-typed shape for the OpenAI SDK's `responses.create` method
 *  (non-streaming form). Probe is a single round-trip — no SSE needed. */
interface ResponsesCreateCapableSDK {
  responses?: {
    create?: (params: {
      model: string;
      input: string;
      store?: boolean;
      max_output_tokens?: number;
    }) => Promise<{
      id?: string;
      output_text?: string;
      output?: Array<{
        content?: Array<{ type?: string; text?: string }>;
        text?: string;
      }>;
      [key: string]: unknown;
    }>;
  };
}

/** Lowercase + collapse whitespace + strip punctuation for cheap keyword
 *  matching. The probe is text-only so we don't need an LLM parse-pass —
 *  a keyword heuristic is enough to spot "I don't know" / "no goal" /
 *  "no active agents" style drift. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pluck the assistant's text out of whatever SDK response shape we got.
 *  Prefers `output_text` (the canonical field on the Responses API) and
 *  falls back to walking the `output` array. Returns '' on any failure. */
function extractProbeText(
  resp:
    | {
        output_text?: string;
        output?: Array<{
          content?: Array<{ type?: string; text?: string }>;
          text?: string;
        }>;
      }
    | null
    | undefined,
): string {
  if (!resp) return '';
  if (typeof resp.output_text === 'string' && resp.output_text.length > 0) {
    return resp.output_text;
  }
  if (!Array.isArray(resp.output)) return '';
  const chunks: string[] = [];
  for (const item of resp.output) {
    if (typeof item?.text === 'string') chunks.push(item.text);
    if (Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (typeof c?.text === 'string' && (c.type === undefined || c.type === 'output_text' || c.type === 'text')) {
          chunks.push(c.text);
        }
      }
    }
  }
  return chunks.join('\n');
}

/** Map a world-state Agent[] to its names where status is in the
 *  must-preserve set. Tolerates wrong-shape entries. */
function activeAgentNames(world: WorldState | null): string[] {
  if (!world || !Array.isArray(world.active_agents)) return [];
  const out: string[] = [];
  for (const agent of world.active_agents) {
    if (!agent || typeof agent !== 'object') continue;
    const status = (agent as { status?: unknown }).status;
    if (status === 'spawning' || status === 'working' || status === 'blocked') {
      const name = (agent as { name?: unknown; id?: unknown }).name;
      const id = (agent as { id?: unknown }).id;
      if (typeof name === 'string' && name.length > 0) out.push(name);
      else if (typeof id === 'string' && id.length > 0) out.push(id);
    }
  }
  return out;
}

/** Tail-walk the recent transcript for the most recent role:user item.
 *  Returns its `content` (trimmed) or '' if none found. */
function mostRecentUserUtterance(world: WorldState | null): string {
  if (!world || !Array.isArray(world.recent_transcript)) return '';
  for (let i = world.recent_transcript.length - 1; i >= 0; i--) {
    const item = world.recent_transcript[i];
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if (role === 'user' && typeof content === 'string' && content.length > 0) {
      return content.trim();
    }
  }
  return '';
}

/** Lightweight keyword check: does `haystack` mention `needle` (or any of
 *  its space-separated significant tokens)? Used because the probe answer
 *  is a 3-line summary — we look for the goal/agent name/utterance gist,
 *  not exact-match recital. */
function keywordsPresent(haystack: string, needle: string): boolean {
  const normH = normalize(haystack);
  const normN = normalize(needle);
  if (!normN) return true; // nothing to check against — treat as match
  if (!normH) return false;
  // Whole-string match is the strongest signal.
  if (normH.includes(normN)) return true;
  // Short needles (≤8 chars, e.g. an agent name like "Jin" or "Maya") must
  // match by whole-string — no fuzzy token fallback. Otherwise short proper
  // nouns would silently match anything via stopword-only fallback.
  if (normN.length <= 8) return false;
  // Otherwise require ≥1 distinctive token (length ≥4, ignoring filler).
  const stop = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'have', 'has', 'are',
    'was', 'were', 'will', 'from', 'into', 'about', 'their', 'they',
    'them', 'what', 'when', 'where', 'who', 'how', 'why',
  ]);
  const tokens = normN.split(' ').filter((t) => t.length >= 4 && !stop.has(t));
  if (tokens.length === 0) return true; // only filler — can't disprove
  return tokens.some((t) => normH.includes(t));
}

/** Compare the probe text against the world-state facts. Returns the
 *  set of must-preserve blocks the probe DIDN'T mention. Empty set = match. */
function diffProbeAgainstWorld(
  probeText: string,
  world: WorldState | null,
): ProbeMismatch {
  const mismatch: ProbeMismatch = {};

  const goal = typeof world?.current_task === 'string' ? world.current_task.trim() : '';
  if (goal.length > 0 && !keywordsPresent(probeText, goal)) {
    mismatch.goal = goal;
  }

  const agents = activeAgentNames(world);
  if (agents.length > 0) {
    const missing = agents.filter((name) => !keywordsPresent(probeText, name));
    if (missing.length > 0) {
      mismatch.agents = missing;
    }
  }

  const lastUser = mostRecentUserUtterance(world);
  if (lastUser.length > 0 && !keywordsPresent(probeText, lastUser)) {
    mismatch.lastUser = lastUser;
  }

  return mismatch;
}

/** Try the SDK's responses.create with one model, returning the probe
 *  text on success, or null on any failure (caller decides what to do). */
async function callProbeOnce(
  sdk: ResponsesCreateCapableSDK,
  model: string,
): Promise<string | null> {
  const createFn = sdk.responses?.create;
  if (typeof createFn !== 'function') return null;
  try {
    const resp = await createFn.call(sdk.responses, {
      model,
      input: HEALTH_PROBE_PROMPT,
      store: false,
      max_output_tokens: 512,
    });
    return extractProbeText(resp);
  } catch (err) {
    console.warn(
      `[compaction-runner] health-check probe (${model}) failed`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Post-compaction health-check probe.
 *
 * Fires a synthetic single-turn `responses.create` asking the planner to
 * recite the current goal + active agents + most recent user turn, then
 * cross-checks against the side-store world state.
 *
 * Behavior:
 *   - opts.model overrides the primary model (defaults to `gpt-5-mini`).
 *   - On primary-model failure (no SDK method, throw, empty text), falls
 *     back to `gpt-5` once.
 *   - On both-models failure: returns `{ ok: true }` (non-fatal — log
 *     warning and continue; instructions are rebuilt from side-store
 *     every consult anyway).
 *   - On success + match: returns `{ ok: true }`.
 *   - On success + mismatch: returns `{ ok: false, mismatch }` AND
 *     appends a `kind: 'health-check-mismatch'` entry to
 *     `orchestrator.jsonl` for diagnostics.
 *
 * NEVER throws — every failure surface returns a structured result so
 * the caller (planner) can keep advancing the chain.
 */
export async function runHealthCheckProbe(
  client: OpenAI,
  sideStoreReader: () => Promise<WorldState>,
  opts?: { model?: string },
): Promise<ProbeResult> {
  // Read world state up-front. If the side store itself blows up, we
  // can't cross-check anything — degrade to ok:true (the planner will
  // still rebuild instructions from disk on the next consult).
  let world: WorldState | null = null;
  try {
    world = await sideStoreReader();
  } catch (err) {
    console.warn(
      '[compaction-runner] health-check probe: side-store read failed',
      err instanceof Error ? err.message : err,
    );
    return { ok: true };
  }

  const sdk = client as unknown as ResponsesCreateCapableSDK;
  const primaryModel = opts?.model ?? HEALTH_PROBE_MODEL_PRIMARY;

  let probeText = await callProbeOnce(sdk, primaryModel);
  if (probeText === null || probeText.length === 0) {
    // Fall back to the strong model — but only if the primary wasn't
    // already it (so a caller-supplied model gets ONE retry against the
    // canonical fallback).
    if (primaryModel !== HEALTH_PROBE_MODEL_FALLBACK) {
      probeText = await callProbeOnce(sdk, HEALTH_PROBE_MODEL_FALLBACK);
    }
  }

  if (probeText === null || probeText.length === 0) {
    // Both calls failed (or SDK missing the method). Non-fatal: the
    // planner's instructions are rebuilt every consult, so a missed
    // probe just costs us ONE re-injection signal.
    console.warn(
      '[compaction-runner] health-check probe produced no text; treating as ok (non-fatal)',
    );
    return { ok: true };
  }

  const mismatch = diffProbeAgainstWorld(probeText, world);
  const hasMismatch =
    !!mismatch.goal ||
    (Array.isArray(mismatch.agents) && mismatch.agents.length > 0) ||
    !!mismatch.lastUser;

  if (!hasMismatch) {
    return { ok: true };
  }

  // Mismatch detected — log to orchestrator.jsonl for diagnostics. We
  // intentionally encode the mismatch payload into `summary` (rather
  // than extend the OrchestratorEntry schema in this lane) so the
  // existing side-store helper is the only writer.
  try {
    let summary: string;
    try {
      summary = `probe-mismatch:${JSON.stringify(mismatch)}`;
    } catch {
      summary = 'probe-mismatch:<unserializable>';
    }
    await appendOrchestratorEntry({
      at: Date.now(),
      kind: 'health-check-mismatch',
      responseId: null,
      previousResponseId: null,
      model: primaryModel,
      usage: null,
      summary: summary.slice(0, 480),
    });
  } catch (logErr) {
    console.warn(
      '[compaction-runner] failed to append health-check entry to orchestrator.jsonl',
      logErr,
    );
  }

  return { ok: false, mismatch };
}

// Test-only surfaces — used by unit tests to drive the deterministic
// diff logic without an LLM round-trip. Not part of the public API.
export const _internal_for_tests = {
  diffProbeAgainstWorld,
  extractProbeText,
  activeAgentNames,
  mostRecentUserUtterance,
  keywordsPresent,
};
