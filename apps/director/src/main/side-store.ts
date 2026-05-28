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
  await fs.writeFile(tmp, data, 'utf8');
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
