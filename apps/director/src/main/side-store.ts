/**
 * Side store — on-disk source of truth for Director's session state.
 *
 * Lives at ~/.director/sessions/<session-id>/. Atomic writes (tmp + rename)
 * so partial writes never corrupt a file. Schema in docs/contracts.md § 6.
 *
 * Path-vs-role: this file is physically in main/ because Node FS lives in
 * main, but logical ownership is W3 (STATE). See docs/contracts.md § 13.3.
 *
 * The planner service (`main/planner.ts`) consumes `readWorldState()` as
 * its context payload. Other workers (tool-router, sim, realtime client)
 * call the append helpers at the moments documented in § 14.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type {
  Agent,
  AgentId,
  CanvasComponentName,
  CanvasComponentProps,
  HarnessRule,
  TranscriptItem,
} from '../shared/state.js';
import { IpcChannel } from '../shared/ipc.js';

// ─── Types specific to the side store ───────────────────────────────────

export type DecisionKind =
  | 'harness_rule'
  | 'agent_dispatched'
  | 'agent_block_resolved'
  | 'agent_completed'
  | 'canvas_picked'
  | 'goal_set'
  | 'other';

export interface Decision {
  /** ms epoch. */
  at: number;
  kind: DecisionKind;
  payload: Record<string, unknown>;
}

export interface LastCanvas {
  component: CanvasComponentName | string;
  /** Short stringified summary — full props live in transcript / decisions. */
  props_summary: string;
}

export interface WorldState {
  session_id: string;
  active_agents: Agent[];
  harness: HarnessRule[];
  recent_decisions: Decision[];
  recent_transcript: TranscriptItem[];
  current_task: string | null;
  last_canvas: LastCanvas | null;
  /** ms epoch when this view was materialized. */
  generated_at: number;
}

// ─── Session bootstrap ──────────────────────────────────────────────────

let sessionId: string | null = null;
let sessionDir: string | null = null;

export interface InitSessionOptions {
  /** Override (tests / replay). Defaults to a timestamp + uuid slug. */
  sessionId?: string;
}

/**
 * Idempotent. Generates a session ID and ensures the on-disk layout exists.
 * Safe to call multiple times — returns the cached pair after the first call.
 */
export async function initSession(
  opts?: InitSessionOptions,
): Promise<{ sessionId: string; dir: string }> {
  if (sessionId && sessionDir) {
    return { sessionId, dir: sessionDir };
  }
  const slug =
    opts?.sessionId ??
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const dir = join(homedir(), '.director', 'sessions', slug);
  await fs.mkdir(join(dir, 'agents'), { recursive: true });
  sessionId = slug;
  sessionDir = dir;
  return { sessionId, dir };
}

/** Test-only: drop the cached session so a fresh init takes effect. */
export function _resetSessionForTests(): void {
  sessionId = null;
  sessionDir = null;
}

export function getSessionId(): string | null {
  return sessionId;
}

export function getSessionDir(): string | null {
  return sessionDir;
}

function requireDir(): string {
  if (!sessionDir) {
    throw new Error(
      '[side-store] initSession() must be called before any read/write',
    );
  }
  return sessionDir;
}

// ─── Atomic write helpers ───────────────────────────────────────────────

async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  // Advisory 11: fsync the tmp file's data to disk BEFORE the rename so a
  // crash between write and rename can't leave a torn / zero-length file
  // visible at `path`. Mirrors the open+sync+close pattern in
  // `atomicAppendLine`. fsync is best-effort — some filesystems return
  // EINVAL / ENOTSUP, which we swallow (the rename still gives atomicity).
  const fh = await fs.open(tmp, 'w');
  try {
    await fh.writeFile(data, 'utf8');
    try {
      await fh.sync();
    } catch {
      // Best-effort fsync; ignore EINVAL / ENOTSUP on some filesystems.
    }
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, path);
}

async function atomicAppendLine(path: string, line: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const fh = await fs.open(path, 'a');
  try {
    await fh.appendFile(line.endsWith('\n') ? line : `${line}\n`, 'utf8');
    try {
      await fh.sync();
    } catch {
      // Best-effort fsync; ignore EINVAL / ENOTSUP on some filesystems.
    }
  } finally {
    await fh.close();
  }
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function readJsonlSafely<T>(path: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          return null;
        }
      })
      .filter((v): v is T => v !== null);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
}

// ─── Harness (full overwrite) ───────────────────────────────────────────

export async function readHarness(): Promise<HarnessRule[]> {
  try {
    const raw = await fs.readFile(join(requireDir(), 'harness.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HarnessRule[]) : [];
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
}

export async function writeHarness(rules: HarnessRule[]): Promise<void> {
  await atomicWrite(
    join(requireDir(), 'harness.json'),
    JSON.stringify(rules, null, 2),
  );
}

export async function appendHarnessRule(
  rule: HarnessRule,
): Promise<HarnessRule[]> {
  const current = await readHarness();
  const next = [...current, rule];
  await writeHarness(next);
  return next;
}

// ─── Decisions (JSONL append) ───────────────────────────────────────────

export async function appendDecision(decision: Decision): Promise<void> {
  await atomicAppendLine(
    join(requireDir(), 'decisions.jsonl'),
    JSON.stringify(decision),
  );
}

export async function readRecentDecisions(limit = 20): Promise<Decision[]> {
  const all = await readJsonlSafely<Decision>(
    join(requireDir(), 'decisions.jsonl'),
  );
  return limit > 0 ? all.slice(-limit) : all;
}

// ─── Agents (one file per agent, debounced writes) ──────────────────────

interface PendingAgentWrite {
  timer: NodeJS.Timeout;
  agent: Agent;
}
const agentWriteTimers = new Map<AgentId, PendingAgentWrite>();
const AGENT_WRITE_DEBOUNCE_MS = 100;

function agentPath(id: AgentId): string {
  return join(requireDir(), 'agents', `${id}.json`);
}

export async function writeAgent(agent: Agent): Promise<void> {
  await atomicWrite(agentPath(agent.id), JSON.stringify(agent, null, 2));
}

/**
 * Debounced version — fast successive updates (sim trail ticks) only hit
 * disk every 100ms. Use this from sim driver / store-mirror code paths.
 */
export function queueAgentWrite(agent: Agent): void {
  const existing = agentWriteTimers.get(agent.id);
  if (existing) clearTimeout(existing.timer);
  // Snapshot the agent at enqueue time so later mutations don't get persisted.
  const frozen: Agent = { ...agent };
  const timer = setTimeout(() => {
    agentWriteTimers.delete(agent.id);
    writeAgent(frozen).catch((err) =>
      console.error(`[side-store] agent ${frozen.id} write failed`, err),
    );
  }, AGENT_WRITE_DEBOUNCE_MS);
  agentWriteTimers.set(agent.id, { timer, agent: frozen });
}

/**
 * Flush any pending debounced agent writes immediately. Call on app quit
 * so trailing state doesn't get lost to a 100ms timer that never fired.
 *
 * Fix: prior implementation cleared the timers WITHOUT firing the writes,
 * silently losing in-flight state. Now we cancel timers + write each
 * pending snapshot to disk synchronously (awaiting the parallel writes).
 */
export async function flushAgentWrites(): Promise<void> {
  const pending = Array.from(agentWriteTimers.values());
  pending.forEach((p) => clearTimeout(p.timer));
  agentWriteTimers.clear();
  await Promise.all(
    pending.map((p) =>
      writeAgent(p.agent).catch((err) =>
        console.error(`[side-store] flush write failed for ${p.agent.id}`, err),
      ),
    ),
  );
}

export async function readAgent(id: AgentId): Promise<Agent | null> {
  try {
    const raw = await fs.readFile(agentPath(id), 'utf8');
    return JSON.parse(raw) as Agent;
  } catch (err) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

export async function readAllAgents(): Promise<Agent[]> {
  const dir = join(requireDir(), 'agents');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  const agents: Agent[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(join(dir, file), 'utf8');
      agents.push(JSON.parse(raw) as Agent);
    } catch (err) {
      console.warn(`[side-store] skipping unreadable agent file ${file}`, err);
    }
  }
  return agents;
}

// ─── Transcript (JSONL append) ──────────────────────────────────────────

export async function appendTranscript(item: TranscriptItem): Promise<void> {
  await atomicAppendLine(
    join(requireDir(), 'transcript.jsonl'),
    JSON.stringify(item),
  );
}

export async function readRecentTranscript(
  limit = 20,
): Promise<TranscriptItem[]> {
  const all = await readJsonlSafely<TranscriptItem>(
    join(requireDir(), 'transcript.jsonl'),
  );
  return limit > 0 ? all.slice(-limit) : all;
}

// ─── World state (derived view) ─────────────────────────────────────────

let currentTask: string | null = null;
let lastCanvas: LastCanvas | null = null;

export function setCurrentTask(task: string | null): void {
  currentTask = task;
}

export function getCurrentTask(): string | null {
  return currentTask;
}

export function setLastCanvas(
  component: CanvasComponentName | string,
  props: CanvasComponentProps | Record<string, unknown> | undefined,
): void {
  lastCanvas = {
    component,
    props_summary: summarizeProps(props),
  };
}

export function clearLastCanvas(): void {
  lastCanvas = null;
}

function summarizeProps(
  props: CanvasComponentProps | Record<string, unknown> | undefined,
): string {
  if (!props) return '';
  try {
    const json = JSON.stringify(props);
    return json.length > 240 ? `${json.slice(0, 237)}...` : json;
  } catch {
    return '';
  }
}

/**
 * Materialize the world-state view consumed by `main/planner.ts`.
 *
 * Auto-initializes the session if not already booted — callers don't need
 * to remember the lifecycle. Always returns a JSON-serializable object.
 */
export async function readWorldState(): Promise<WorldState> {
  const { sessionId: sid } = await initSession();
  const [active_agents, harness, recent_decisions, recent_transcript] =
    await Promise.all([
      readAllAgents(),
      readHarness(),
      readRecentDecisions(20),
      readRecentTranscript(20),
    ]);
  return {
    session_id: sid,
    active_agents,
    harness,
    recent_decisions,
    recent_transcript,
    current_task: currentTask,
    last_canvas: lastCanvas,
    generated_at: Date.now(),
  };
}

/**
 * Snapshot the current world-state to `world-state.json` for inspection /
 * the Phase 6 rotation reseed flow. Not on a hot path — callers decide
 * when to materialize.
 */
export async function snapshotWorldState(): Promise<WorldState> {
  const ws = await readWorldState();
  await atomicWrite(
    join(requireDir(), 'world-state.json'),
    JSON.stringify(ws, null, 2),
  );
  return ws;
}

// ─── IPC wiring ─────────────────────────────────────────────────────────

let ipcRegistered = false;

/**
 * Register IPC handlers. Call once from `main/index.ts` during
 * `app.whenReady()`. Boots the session directory and exposes the snapshot
 * endpoint to the renderer for dev tooling / planner round-trips.
 */
export async function registerSideStoreIpc(): Promise<void> {
  await initSession();
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(IpcChannel.SidestoreSnapshot, async () => {
    try {
      const world = await readWorldState();
      return { ok: true as const, world };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  });
}

export type SidestoreSnapshotResponse =
  | { ok: true; world: WorldState }
  | { ok: false; error: string };

// ─── § orchestrator-log (W1 — P7.1 + P7.2) ──────────────────────────────
// Append-only marker per docs/contracts.md § 13.1. This block adds the
// orchestrator.jsonl writer + tail reader the planner uses for
// `previous_response_id` chaining and compaction event logging. Do NOT
// modify the helpers above; extend below the marker only.

/**
 * Kind of orchestrator-log entry. `response` is appended after every
 * successful `responses.create`; `compaction` after every successful
 * manual `responses.compact` (or fallback); `health-check-mismatch` is
 * reserved for Main's P7.3 health-check probe.
 */
export type OrchestratorEntryKind =
  | 'response'
  | 'compaction'
  | 'health-check-mismatch';

export interface OrchestratorUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  /** Future-proof — preserve any extra fields the API ships. */
  [key: string]: unknown;
}

export interface OrchestratorEntry {
  /** ms epoch. */
  at: number;
  kind: OrchestratorEntryKind;
  /** The new response id this turn produced. May be null on noop fallback. */
  responseId: string | null;
  /** The chain predecessor — i.e. the prior `lastResponseId`. */
  previousResponseId: string | null;
  /** Planner / compaction model id, for forensic trail across model bumps. */
  model: string;
  /** Whatever the API returned. Schema-loose so we can grow without a bump. */
  usage?: OrchestratorUsage | null;
  /** Optional one-line summary (e.g. compaction fallback reason). */
  summary?: string;
}

/**
 * Atomic append of a single orchestrator-log entry. Mirrors the
 * `appendDecision` helper — same atomic `fs.open('a')` + `fsync` pattern.
 * Defensive: out-of-band entries are coerced to safe defaults rather
 * than dropped.
 */
export async function appendOrchestratorEntry(
  entry: OrchestratorEntry,
): Promise<void> {
  // Defensive coercion — never throw on a malformed input.
  const safe: OrchestratorEntry = {
    at: typeof entry?.at === 'number' && Number.isFinite(entry.at)
      ? entry.at
      : Date.now(),
    kind:
      entry?.kind === 'response' ||
      entry?.kind === 'compaction' ||
      entry?.kind === 'health-check-mismatch'
        ? entry.kind
        : 'response',
    responseId:
      typeof entry?.responseId === 'string' && entry.responseId.length > 0
        ? entry.responseId
        : null,
    previousResponseId:
      typeof entry?.previousResponseId === 'string' &&
      entry.previousResponseId.length > 0
        ? entry.previousResponseId
        : null,
    model:
      typeof entry?.model === 'string' && entry.model.length > 0
        ? entry.model
        : 'unknown',
    usage: entry?.usage ?? null,
    summary:
      typeof entry?.summary === 'string' ? entry.summary : undefined,
  };
  await atomicAppendLine(
    join(requireDir(), 'orchestrator.jsonl'),
    JSON.stringify(safe),
  );
}

/**
 * Read the orchestrator log; latest entries last (file order). Used by
 * the planner on boot to recover `lastResponseId` and by the P7.3 health
 * probe to diff intent vs reality.
 *
 * `limit > 0` slices to the last N entries (cheap for hot paths); pass
 * `limit = 0` to read the entire log.
 */
export async function readOrchestratorLog(
  limit = 50,
): Promise<OrchestratorEntry[]> {
  const all = await readJsonlSafely<OrchestratorEntry>(
    join(requireDir(), 'orchestrator.jsonl'),
  );
  return limit > 0 ? all.slice(-limit) : all;
}

/**
 * Convenience: walk the orchestrator log tail to recover the most recent
 * `responseId`. Returns null on empty / never-run. The planner calls this
 * on boot so a restart picks up the chain instead of starting fresh.
 *
 * We accept ANY entry kind (response | compaction) because compaction
 * also mints a new response id that the next turn should chain from.
 */
export async function readLastOrchestratorResponseId(): Promise<string | null> {
  const tail = await readOrchestratorLog(50);
  for (let i = tail.length - 1; i >= 0; i--) {
    const e = tail[i];
    if (e && typeof e.responseId === 'string' && e.responseId.length > 0) {
      return e.responseId;
    }
  }
  return null;
}

// ─── § state-snapshot+meta (W3 — P6.3 + P6.3b) ──────────────────────────
// Append-only marker per docs/contracts.md § 13.1. This block adds:
//
//   - `writeStateSnapshot(snapshot)`  — debounced 1.5s persistor for the
//     renderer's serializable store at `state.snapshot.json`.
//   - `forceFlushSnapshot()`          — synchronous trailing flush for
//     `app.quit`, session rotation, post-orchestrator response.
//   - `writeMeta(meta)` / `readMeta()` — `meta.json` { projectPath,
//     targetAppDir, name, createdAt, updatedAt, appVersion, currentGoal,
//     schemaVersion } atomic-written on goal / project / version change.
//   - `readSnapshot()`                — hydration source on resume.
//   - `findResumableSession()`        — boot scanner — returns the most
//     recent <7-day-old session by `meta.updatedAt`, with a small preview
//     payload main forwards over `session.resumeAvailable` IPC.
//
// All writes go through `atomicWrite()` (tmp + rename) defined above. All
// reads tolerate missing files / malformed JSON with a safe default.

/** Bump on any incompatible disk format change. */
export const SIDESTORE_SCHEMA_VERSION = 1 as const;

/**
 * `meta.json` shape — small, human-readable session header. Carries the
 * fields the resume flow needs to render a preview ("Pick up <name>?")
 * without loading the full snapshot.
 */
export interface SessionMeta {
  schemaVersion: typeof SIDESTORE_SCHEMA_VERSION;
  /** Filesystem path to the user's project root (e.g. `~/code/mixtape`). */
  projectPath: string | null;
  /** Subdir of `projectPath` Director writes generated code into (optional). */
  targetAppDir: string | null;
  /** Friendly display name — usually `basename(projectPath)`. */
  name: string | null;
  /** ms epoch — first time this session was created. */
  createdAt: number;
  /** ms epoch — last time meta or snapshot was touched. */
  updatedAt: number;
  /** Director app version (`package.json`), useful for migration sniffing. */
  appVersion: string | null;
  /** The active goal string at last meta update; null on fresh session. */
  currentGoal: string | null;
}

/**
 * Lightweight preview surfaced to the renderer on boot. Keep small — this
 * crosses the IPC boundary AND gets read before the user has even said
 * anything yet. Full snapshot lives behind a separate `readSnapshot()`.
 */
export interface ResumableSessionPreview {
  sessionId: string;
  projectName: string | null;
  currentGoal: string | null;
  /** ms epoch of `meta.updatedAt`. */
  lastActiveAt: number;
  /** Absolute path to the session directory. */
  dir: string;
}

/** Persisted shape of `state.snapshot.json`. Wraps the serializable store
 *  with a schema version so future versions can migrate cleanly. */
export interface PersistedSnapshot {
  schemaVersion: typeof SIDESTORE_SCHEMA_VERSION;
  /** ms epoch of write. */
  at: number;
  /** Serializable view of the renderer store (no timer handles etc). */
  store: unknown;
}

const SNAPSHOT_DEBOUNCE_MS = 1500;
const RESUMABLE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Single in-flight debounce state. We coalesce multiple `writeStateSnapshot`
// calls within `SNAPSHOT_DEBOUNCE_MS` into one disk write — keeps the
// renderer free to spam state mutations without thrashing the FS.
let snapshotTimer: NodeJS.Timeout | null = null;
let snapshotPending: unknown = null;
let snapshotInFlight: Promise<void> | null = null;

function snapshotFilePath(): string {
  return join(requireDir(), 'state.snapshot.json');
}

function metaFilePath(): string {
  return join(requireDir(), 'meta.json');
}

/**
 * Advisory 12: strip obviously-ephemeral runtime noise before persisting
 * the snapshot. These fields are recomputed live on the next launch and
 * have no business surviving a restart — persisting them only bloats the
 * file and risks resuming with stale "in-flight" markers.
 *
 *   - `realtime.vadActivity`            — momentary VAD energy meter.
 *   - `orchestrator.inFlightToolCalls`  — calls that died with the process.
 *
 * Defensive: operates on a shallow-cloned copy so we never mutate the
 * renderer's live store object, and tolerates any non-object input
 * (returns it unchanged).
 */
function stripEphemerals(store: unknown): unknown {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    return store;
  }
  const src = store as Record<string, unknown>;
  const out: Record<string, unknown> = { ...src };

  // session.realtime.vadActivity — strip under either `session` or top-level
  // `realtime` (the serializable store nests realtime at the top level; the
  // advisory references the `session.realtime.*` logical path).
  const realtime = out.realtime;
  if (realtime && typeof realtime === 'object' && !Array.isArray(realtime)) {
    const { vadActivity: _vad, ...restRealtime } = realtime as Record<
      string,
      unknown
    >;
    void _vad;
    out.realtime = restRealtime;
  }
  const session = out.session;
  if (session && typeof session === 'object' && !Array.isArray(session)) {
    const sessionObj = session as Record<string, unknown>;
    const sessRealtime = sessionObj.realtime;
    if (
      sessRealtime &&
      typeof sessRealtime === 'object' &&
      !Array.isArray(sessRealtime)
    ) {
      const { vadActivity: _v, ...restSessRealtime } = sessRealtime as Record<
        string,
        unknown
      >;
      void _v;
      out.session = { ...sessionObj, realtime: restSessRealtime };
    }
  }

  // orchestrator.inFlightToolCalls — transient per-process call tracking.
  const orchestrator = out.orchestrator;
  if (
    orchestrator &&
    typeof orchestrator === 'object' &&
    !Array.isArray(orchestrator)
  ) {
    const { inFlightToolCalls: _calls, ...restOrch } = orchestrator as Record<
      string,
      unknown
    >;
    void _calls;
    out.orchestrator = restOrch;
  }

  return out;
}

async function flushSnapshotNow(): Promise<void> {
  const data = snapshotPending;
  snapshotPending = null;
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  if (data === null) return;
  const payload: PersistedSnapshot = {
    schemaVersion: SIDESTORE_SCHEMA_VERSION,
    at: Date.now(),
    store: stripEphemerals(data),
  };
  try {
    await atomicWrite(snapshotFilePath(), JSON.stringify(payload));
  } catch (err) {
    console.warn('[side-store] state.snapshot.json write failed', err);
  }
}

/**
 * Persist a serializable renderer store snapshot to
 * `state.snapshot.json`. Debounced — successive calls within 1.5s
 * collapse into a single trailing write. Use `forceFlushSnapshot()` to
 * drain the queue at quit / rotation / post-orch-response.
 *
 * Defensive: callers may pass `null` / wrong shape; we accept anything
 * structured-clone-safe and let the JSON serializer decide.
 */
export function writeStateSnapshot(snapshot: unknown): void {
  if (snapshot === undefined) {
    console.warn('[side-store] writeStateSnapshot called with undefined; ignoring');
    return;
  }
  snapshotPending = snapshot;
  if (snapshotTimer) return; // already scheduled — leading-edge debounce
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    snapshotInFlight = flushSnapshotNow().finally(() => {
      snapshotInFlight = null;
    });
  }, SNAPSHOT_DEBOUNCE_MS);
}

/**
 * Synchronously drain the pending snapshot (if any) and await both the
 * trailing in-flight write AND the freshly-flushed write. Safe to call
 * even when no snapshot has been queued.
 *
 * `before-quit` and the session-rotation handshake call this.
 */
export async function forceFlushSnapshot(): Promise<void> {
  // Always run a fresh flush (even with no queued data so the in-flight
  // promise gets awaited deterministically).
  await flushSnapshotNow();
  if (snapshotInFlight) {
    try {
      await snapshotInFlight;
    } catch (err) {
      console.warn('[side-store] forceFlushSnapshot in-flight rejected', err);
    }
  }
}

/** Read the last-persisted snapshot — or null on missing / corrupt file. */
export async function readSnapshot(
  dir?: string,
): Promise<PersistedSnapshot | null> {
  const path = dir ? join(dir, 'state.snapshot.json') : snapshotFilePath();
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as PersistedSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    if (isENOENT(err)) return null;
    console.warn(`[side-store] readSnapshot failed for ${path}`, err);
    return null;
  }
}

/**
 * Atomic write of `meta.json`. Always carries the current schema version +
 * a fresh `updatedAt`. Missing fields on the input are filled from the
 * existing meta file (creating new sessions with `createdAt: now` if no
 * prior meta exists).
 */
export async function writeMeta(
  patch: Partial<SessionMeta>,
): Promise<SessionMeta> {
  const current = (await readMeta()) ?? {
    schemaVersion: SIDESTORE_SCHEMA_VERSION,
    projectPath: null,
    targetAppDir: null,
    name: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    appVersion: null,
    currentGoal: null,
  };
  const next: SessionMeta = {
    schemaVersion: SIDESTORE_SCHEMA_VERSION,
    projectPath: patch.projectPath ?? current.projectPath,
    targetAppDir: patch.targetAppDir ?? current.targetAppDir,
    name: patch.name ?? current.name,
    createdAt: current.createdAt,
    updatedAt: Date.now(),
    appVersion: patch.appVersion ?? current.appVersion,
    currentGoal:
      patch.currentGoal !== undefined ? patch.currentGoal : current.currentGoal,
  };
  await atomicWrite(metaFilePath(), JSON.stringify(next, null, 2));
  return next;
}

/** Read `meta.json` — or null on missing / corrupt file. */
export async function readMeta(dir?: string): Promise<SessionMeta | null> {
  const path = dir ? join(dir, 'meta.json') : metaFilePath();
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as SessionMeta;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    if (isENOENT(err)) return null;
    console.warn(`[side-store] readMeta failed for ${path}`, err);
    return null;
  }
}

/**
 * Scan `~/.director/sessions/*` for resumable sessions. Returns the most
 * recently active session (by `meta.updatedAt`) that's <7 days old, or
 * null if no candidate exists. Safe on a clean install (no sessions
 * directory = returns null).
 *
 * Boot path uses this BEFORE calling `initSession()` — that way main can
 * either pre-load the existing session id (resume) or let `initSession()`
 * mint a new slug (start fresh).
 */
export async function findResumableSession(opts?: {
  sessionsRoot?: string;
  maxAgeMs?: number;
  now?: number;
}): Promise<ResumableSessionPreview | null> {
  const root =
    opts?.sessionsRoot ?? join(homedir(), '.director', 'sessions');
  const maxAge = opts?.maxAgeMs ?? RESUMABLE_WINDOW_MS;
  const now = opts?.now ?? Date.now();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if (isENOENT(err)) return null;
    console.warn('[side-store] findResumableSession readdir failed', err);
    return null;
  }
  let best: ResumableSessionPreview | null = null;
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = await readMeta(dir);
    if (!meta || typeof meta.updatedAt !== 'number') continue;
    if (now - meta.updatedAt > maxAge) continue;
    const preview: ResumableSessionPreview = {
      sessionId: entry,
      projectName: meta.name ?? meta.projectPath ?? entry,
      currentGoal: meta.currentGoal ?? null,
      lastActiveAt: meta.updatedAt,
      dir,
    };
    if (!best || preview.lastActiveAt > best.lastActiveAt) {
      best = preview;
    }
  }
  return best;
}

// ─── § renderer-wireup (gap 6) — resume hydration ────────────────────────
// Re-point the in-memory session pointer at an existing on-disk session so
// subsequent planner / persistence reads target the resumed dir. The boot
// path already called `initSession()` (minting a fresh slug); resuming
// swaps that pointer to the chosen session id. Returns the resumed dir +
// the snapshot's last goal (for the planner's first consult instructions,
// which it rebuilds from the side store on every call — we don't touch the
// planner internals here, just the on-disk source it reads from).
export async function hydrateExistingSession(
  resumeSessionId: string,
): Promise<{ dir: string; goal: string | null }> {
  const dir = join(homedir(), '.director', 'sessions', resumeSessionId);
  // Verify the dir exists before swapping the pointer.
  await fs.stat(dir); // throws ENOENT if missing — caller catches.
  sessionId = resumeSessionId;
  sessionDir = dir;
  const meta = await readMeta(dir);
  const snapshot = await readSnapshot(dir);
  const goal =
    meta?.currentGoal ??
    (snapshot &&
    typeof snapshot.store === 'object' &&
    snapshot.store !== null &&
    'goal' in snapshot.store
      ? ((snapshot.store as { goal?: string | null }).goal ?? null)
      : null);
  // Touch updatedAt so the resumed session sorts to the front next time.
  try {
    await writeMeta({});
  } catch (err) {
    console.warn('[side-store] hydrateExistingSession writeMeta touch failed', err);
  }
  return { dir, goal };
}

/** Test-only: drop the in-memory snapshot debounce so a new test can
 *  start clean. Mirrors `_resetSessionForTests()` semantics. */
export function _resetSnapshotForTests(): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
  snapshotPending = null;
  snapshotInFlight = null;
}

// ─── § persistence-wiring (gap 5) ───────────────────────────────────────
// Append-only marker per docs/contracts.md § 13.1. This block wires the
// previously-dead `writeStateSnapshot` + `writeMeta` writers into a real
// production call path:
//
//   - `registerSnapshotPushIpc()` subscribes to the renderer's
//     `state.snapshotPush` channel. Main keeps NO full state mirror; the
//     renderer (canonical zustand store) pushes its serialized store on
//     each meaningful mutation. We forward the store to `writeStateSnapshot`
//     (debounced 1.5s internally) and, whenever the goal string changes
//     versus the last push, atomically `writeMeta({ currentGoal })`.
//   - `writeSessionInitMeta()` writes `meta.json` once at boot with the
//     app version + project path so the resume scanner has a header even
//     before the first goal is set.
//
// Defensive: a malformed push is dropped with a `console.warn`; a write
// failure is logged but never thrown (the renderer fire-and-forgets).

/** Last goal main observed via a snapshot push — used to gate `writeMeta`
 *  so we only touch `meta.json` when the goal actually changes. `undefined`
 *  means "no push seen yet" (distinct from an explicit null goal). */
let lastObservedGoal: string | null | undefined = undefined;

let snapshotPushIpcRegistered = false;

/**
 * Register the `state.snapshotPush` listener. Idempotent. Call once from
 * `main/index.ts` during `app.whenReady()` (after `registerSideStoreIpc`).
 *
 * The handler is fire-and-forget from the renderer's side: it persists the
 * pushed store snapshot (debounced) and, on goal change, the meta header.
 */
export function registerSnapshotPushIpc(): void {
  if (snapshotPushIpcRegistered) return;
  snapshotPushIpcRegistered = true;
  ipcMain.on(
    IpcChannel.StateSnapshotPush,
    (_evt, payload: { snapshot?: unknown; goal?: string | null }) => {
      if (!payload || typeof payload !== 'object') {
        console.warn('[side-store] state.snapshotPush dropped malformed payload');
        return;
      }
      // Persist the store snapshot (internally debounced 1.5s + strips
      // ephemerals). `undefined` snapshot is ignored by writeStateSnapshot.
      writeStateSnapshot(payload.snapshot);

      // Goal-change → meta.json. Only write when the goal string differs
      // from the last push so we don't rewrite meta on every keystroke.
      const goal =
        payload.goal === undefined
          ? null
          : payload.goal;
      if (goal !== lastObservedGoal) {
        lastObservedGoal = goal;
        writeMeta({ currentGoal: goal }).catch((err) =>
          console.warn('[side-store] writeMeta on goal change failed', err),
        );
      }
    },
  );
}

/**
 * Write the `meta.json` header once at session init with the app version +
 * project path. Idempotent-friendly: `writeMeta` merges with any existing
 * meta and refreshes `updatedAt`, so re-running on resume is harmless.
 *
 * `appVersion` comes from the caller (main reads its own package version);
 * `projectPath` defaults to null until a project is opened.
 */
export async function writeSessionInitMeta(opts?: {
  appVersion?: string | null;
  projectPath?: string | null;
  name?: string | null;
}): Promise<SessionMeta> {
  return writeMeta({
    appVersion: opts?.appVersion ?? null,
    projectPath: opts?.projectPath ?? null,
    name: opts?.name ?? null,
  });
}

/** Test-only — reset the goal-change gate so a fresh test starts clean. */
export function _resetSnapshotPushForTests(): void {
  lastObservedGoal = undefined;
  snapshotPushIpcRegistered = false;
}
