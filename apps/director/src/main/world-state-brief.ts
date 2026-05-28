/**
 * Pure builder for the World State Brief — the system-role conversation
 * item Director hands to Session_B at rotation time so prompt context
 * survives the cold mint.
 *
 * Lives as a standalone, dependency-free module so it can be unit-tested
 * without Electron, fetch, or fs. The caller (main/realtime.ts) reads the
 * side store, hands the resulting `WorldState` snapshot here, and gets
 * back a structurally-clone-safe `WorldStateBrief`.
 *
 * Per docs/architecture.md §4 + docs/remaining-phases.md §6.1, the Brief
 * MUST contain:
 *   - active harness rules verbatim
 *   - active agents + statuses
 *   - current goal
 *   - last canvas state
 *   - last 6 transcript items
 *   - elapsed time since session start
 *
 * Defensive: every field tolerates missing/wrong-typed input. Never throws.
 */
import type {
  CanvasComponentName,
  HarnessRule,
  TranscriptItem,
  WorldStateBrief,
} from '../shared/state.js';

/**
 * Subset of the side-store WorldState the brief builder cares about. We
 * type the input loosely so tests can construct minimal fixtures.
 */
export interface BriefSourceSnapshot {
  /** Active agents from `agents/*.json`. */
  active_agents?: ReadonlyArray<{
    id?: unknown;
    name?: unknown;
    role?: unknown;
    status?: unknown;
    currentTask?: unknown;
    current_task?: unknown;
    task?: unknown;
  }>;
  /** Harness rules from `harness.json`. */
  harness?: ReadonlyArray<HarnessRule | { rule?: unknown }>;
  /** Transcript tail from `transcript.jsonl`. */
  recent_transcript?: ReadonlyArray<TranscriptItem | Record<string, unknown>>;
  /** From `meta.json:currentGoal`. */
  current_task?: unknown;
  goal?: unknown;
  /** From `canvas.last.json` or in-memory snapshot. */
  last_canvas?: {
    component?: unknown;
    props_summary?: unknown;
    props?: unknown;
    awaiting_response?: unknown;
    awaitingResponse?: unknown;
  } | null;
}

export interface BuildBriefOptions {
  /** Session start time (ms epoch). Defaults to now if omitted. */
  sessionStartedAt?: number;
  /** Brief generation time (ms epoch). Defaults to Date.now(). */
  now?: number;
  /** Max transcript items to include (default 6). */
  transcriptLimit?: number;
}

const DEFAULT_TRANSCRIPT_LIMIT = 6;

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function safeString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function pickTranscriptItem(raw: unknown): TranscriptItem | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const id = asString(rec.id);
  const role = asString(rec.role);
  const content = typeof rec.content === 'string' ? rec.content : null;
  const timestamp = typeof rec.timestamp === 'number' ? rec.timestamp : null;
  if (!id || !role || content === null || timestamp === null) return null;
  const item: TranscriptItem = {
    id,
    role: role as TranscriptItem['role'],
    content,
    timestamp,
  };
  const phase = asString(rec.phase);
  if (phase === 'commentary' || phase === 'final_answer') item.phase = phase;
  const realtimeItemId = asString(rec.realtimeItemId);
  if (realtimeItemId) item.realtimeItemId = realtimeItemId;
  const metadata = asRecord(rec.metadata);
  if (metadata) {
    const kind = asString(metadata.kind);
    if (kind) item.metadata = { kind: kind as NonNullable<TranscriptItem['metadata']>['kind'] };
  }
  return item;
}

/**
 * Build a `WorldStateBrief` from a side-store snapshot. Pure: same input →
 * same output (modulo the `elapsedMs` calculation, which derives from
 * `now - sessionStartedAt`).
 */
export function buildWorldStateBrief(
  snapshot: BriefSourceSnapshot | null | undefined,
  opts: BuildBriefOptions = {},
): WorldStateBrief {
  const now = opts.now ?? Date.now();
  const startedAt = opts.sessionStartedAt ?? now;
  const limit = Math.max(0, opts.transcriptLimit ?? DEFAULT_TRANSCRIPT_LIMIT);

  const safe = snapshot ?? {};

  // ── Harness: rule strings verbatim, drop empties. ──────────────────────
  const harnessRules: string[] = [];
  for (const entry of safe.harness ?? []) {
    const rec = asRecord(entry);
    const rule = rec ? asString(rec.rule) : null;
    if (rule) harnessRules.push(rule);
  }

  // ── Agents: id + name + role + status + task. Tolerate snake/camel. ───
  const activeAgents: WorldStateBrief['activeAgents'] = [];
  for (const raw of safe.active_agents ?? []) {
    const rec = asRecord(raw);
    if (!rec) continue;
    const id = asString(rec.id);
    if (!id) continue;
    const name = asString(rec.name) ?? id;
    const role = asString(rec.role) ?? 'Frontend';
    const status = asString(rec.status) ?? 'working';
    const task =
      asString(rec.currentTask) ??
      asString(rec.current_task) ??
      asString(rec.task);
    activeAgents.push({
      id,
      name,
      role,
      status: status as WorldStateBrief['activeAgents'][number]['status'],
      task,
    });
  }

  // ── Goal: prefer explicit goal field, fall back to current_task. ───────
  const goal = asString(safe.goal) ?? asString(safe.current_task);

  // ── Last canvas: try to surface enough for a recap. ────────────────────
  let lastCanvas: WorldStateBrief['lastCanvas'] = null;
  const canvasRec = safe.last_canvas;
  if (canvasRec && typeof canvasRec === 'object') {
    const component = asString(canvasRec.component);
    if (component) {
      const props = asRecord(canvasRec.props) ?? {};
      const propsSummary = asString(canvasRec.props_summary);
      const awaitingResponse =
        canvasRec.awaiting_response === true ||
        canvasRec.awaitingResponse === true;
      lastCanvas = {
        component: component as CanvasComponentName,
        props: propsSummary
          ? { summary: propsSummary, ...props }
          : props,
        awaitingResponse,
      };
    }
  }

  // ── Transcript: keep order, cap at limit (newest at end). ──────────────
  const allItems: TranscriptItem[] = [];
  for (const raw of safe.recent_transcript ?? []) {
    const item = pickTranscriptItem(raw);
    if (item) allItems.push(item);
  }
  const recentTranscript =
    limit === 0 ? [] : allItems.slice(Math.max(0, allItems.length - limit));

  const elapsedMs = Math.max(0, now - startedAt);

  return {
    harnessRules,
    activeAgents,
    goal,
    lastCanvas,
    recentTranscript,
    elapsedMs,
  };
}

/**
 * Render the Brief as a plain-text block for injection into Session_B as
 * a `system` role conversation item. Stable, ordered, human-readable.
 *
 * The renderer uses this to construct the `conversation.item.create`
 * payload at rotation time — keeping the format in one place avoids drift
 * between what the planner reads from disk and what the realtime session
 * sees.
 */
export function renderBriefAsSystemText(brief: WorldStateBrief): string {
  const lines: string[] = [];
  lines.push('# Director — session rotation brief');
  lines.push(
    `Continuing from a prior Realtime session (~${Math.round(
      brief.elapsedMs / 1000,
    )}s elapsed). Treat the items below as established context.`,
  );

  if (brief.goal) {
    lines.push('', '## Current goal', brief.goal);
  }

  if (brief.harnessRules.length > 0) {
    lines.push('', '## Active harness rules (verbatim, must honor)');
    for (const rule of brief.harnessRules) lines.push(`- ${rule}`);
  }

  if (brief.activeAgents.length > 0) {
    lines.push('', '## Active sub-agents');
    for (const a of brief.activeAgents) {
      const task = a.task ? ` — ${a.task}` : '';
      lines.push(`- ${a.name} (${a.role}, ${a.status})${task}`);
    }
  }

  if (brief.lastCanvas) {
    lines.push(
      '',
      '## Last Canvas',
      `${brief.lastCanvas.component}${
        brief.lastCanvas.awaitingResponse ? ' (awaiting user response)' : ''
      }`,
    );
  }

  if (brief.recentTranscript.length > 0) {
    lines.push('', '## Recent turns (oldest first)');
    for (const item of brief.recentTranscript) {
      const safeContent = safeString(item.content).replace(/\n+/g, ' ').trim();
      lines.push(`- [${item.role}] ${safeContent}`);
    }
  }

  return lines.join('\n');
}
