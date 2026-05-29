/**
 * IPC sync — applies main-process state mutations into the canonical
 * renderer store, and surfaces ask-user prompts from the tool router.
 *
 * The tool router (apps/director/src/main/tool-router.ts) pushes typed
 * `state.patch` events whenever a Realtime tool call needs to mutate
 * renderer state without going through the Realtime data channel. The
 * patch shape is intentionally minimal — each `patch.action` maps to a
 * single store command.
 *
 * Initialize once at app boot by importing for side-effects:
 *
 *   import './state/ipcSync';
 *
 * (or via the explicit `initIpcSync()` if you want lifecycle control).
 */

import { commands, useStore } from './store.js';
import type {
  Agent as CanonicalAgent,
  HarnessRule,
} from '../../../shared/state.js';
import type {
  AskShowPayload,
  SessionResumeAvailablePayload,
  StatePatchPayload,
} from '../../../shared/ipc.js';
import type { CodexEvent } from '../../../shared/codex.js';
import { startMixtapeDemo, resolveJinBlocker } from './sim.js';

// ─── Patch action shapes (mirror tool-router) ────────────────────────────

interface AddAgentPatch {
  action: 'addAgent';
  agent: CanonicalAgent;
}

interface UpdateAgentPatch {
  action: 'updateAgent';
  id: string;
  patch: Partial<CanonicalAgent>;
}

interface AddHarnessRulePatch {
  action: 'addHarnessRule';
  rule: HarnessRule;
}

interface StartSimPatch {
  action: 'startSim';
  compressed: boolean;
  seedAgents?: boolean;
}

type StateAction =
  | AddAgentPatch
  | UpdateAgentPatch
  | AddHarnessRulePatch
  | StartSimPatch;

function isAction(v: unknown): v is StateAction {
  return (
    typeof v === 'object' &&
    v !== null &&
    'action' in v &&
    typeof (v as { action: unknown }).action === 'string'
  );
}

// ─── State.patch handler ─────────────────────────────────────────────────

function applyPatch(payload: StatePatchPayload): void {
  const patch = payload.patch;
  if (!isAction(patch)) {
    console.warn('[ipcSync] dropping malformed state.patch', payload);
    return;
  }
  switch (patch.action) {
    case 'addAgent':
      commands.addAgent(patch.agent);
      return;
    case 'updateAgent':
      commands.updateAgent(patch.id, patch.patch);
      return;
    case 'addHarnessRule':
      commands.addHarnessRule(patch.rule);
      return;
    case 'startSim': {
      const compressed = patch.compressed;
      const seedAgents = patch.seedAgents !== false;
      startMixtapeDemo({ compressed, seedAgents });
      return;
    }
    default: {
      const _exhaust: never = patch;
      void _exhaust;
      console.warn('[ipcSync] unknown patch action', patch);
    }
  }
}

// ─── § codex-event-bridge (W3 — P4) ──────────────────────────────────────
//
// Maps `IpcChannel.CodexEvent` records emitted by `main/codex-pool.ts` to
// canonical store commands. The mapping table lives in docs/contracts.md
// § 14 / W3 P4 prompt; the live impl is below.
//
// Each arm is defensive — missing or wrong-typed payload fields produce a
// `console.warn` + noop, never a throw. The pool's payload shapes are
// asserted at the boundary, but the renderer can't trust them blindly
// (mocking, replay, future SDK drift).

const RECENT_FILES_CAP = 3;
const TASK_TRAIL_CAP = 8;

/**
 * Pass 4 identity palette — Frontend / Backend / Data / Design map to the
 * Hive accent ring colors. Mirrors `apps/director/src/main/tool-router.ts`'s
 * IDENTITY table (kept local to avoid a renderer↔main cross-process import).
 */
const ACCENT_FOR_ROLE: Record<string, `#${string}`> = {
  frontend: '#E07856',
  backend: '#4A9E9C',
  data: '#C99550',
  design: '#9670A0',
};
const FALLBACK_ACCENT: `#${string}` = '#9AA0A6';

function accentForRole(role: unknown): `#${string}` {
  if (typeof role !== 'string') return FALLBACK_ACCENT;
  return ACCENT_FOR_ROLE[role.toLowerCase()] ?? FALLBACK_ACCENT;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null
    ? (v as Record<string, unknown>)
    : null;
}

/** Prepend new paths, dedupe by string equality, cap. Newest first. */
function mergeRecentFiles(existing: string[], incoming: string[]): string[] {
  if (incoming.length === 0) return existing;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of [...incoming, ...existing]) {
    if (seen.has(p)) continue;
    seen.add(p);
    result.push(p);
    if (result.length >= RECENT_FILES_CAP) break;
  }
  return result;
}

/**
 * Pure mapper exposed for unit tests. Applies the appropriate `commands.*`
 * call(s) for a single CodexEvent. Returns silently on malformed input.
 *
 * Exported separately from `handleCodexEvent` so tests can drive it without
 * having to go through `initIpcSync()`.
 */
export function handleCodexEvent(event: CodexEvent): void {
  if (!event || typeof event !== 'object') return;
  const id = asString(event.agent_id);
  if (!id) {
    console.warn('[ipcSync] codex event missing agent_id', event);
    return;
  }
  const payload = asObject(event.payload) ?? {};

  switch (event.type) {
    case 'agent_started': {
      const name = asString(payload.name) ?? id;
      const role = asString(payload.role) ?? 'Frontend';
      const task = asString(payload.task);
      const worktree = asString(payload.worktree);
      const existing = useStore.getState().agents[id];
      if (!existing) {
        commands.addAgent({
          id,
          name,
          role,
          accentColor: accentForRole(role),
          status: 'working',
          currentTask: task,
          taskTrail: task ? [task] : [],
          recentFiles: [],
          blocker: null,
          worktreePath: worktree,
          codexThreadId: null,
          dispatchedAt: event.at ?? Date.now(),
          finishedAt: null,
        });
      } else {
        commands.updateAgent(id, {
          status: 'working',
          worktreePath: worktree ?? existing.worktreePath,
          currentTask: task ?? existing.currentTask,
        });
      }
      return;
    }

    case 'thread_started': {
      const threadId = asString(payload.thread_id);
      if (!threadId) {
        console.warn('[ipcSync] thread_started missing thread_id', event);
        return;
      }
      commands.updateAgent(id, { codexThreadId: threadId });
      return;
    }

    case 'file_change': {
      const item = asObject(payload.item);
      const changes = item && Array.isArray(item.changes) ? item.changes : [];
      const incoming: string[] = [];
      // Latest change in the list should land at the front, so we iterate
      // the SDK's order in reverse (preserves "newest last → newest first").
      for (let i = changes.length - 1; i >= 0; i -= 1) {
        const change = asObject(changes[i]);
        const path = change ? asString(change.path) : null;
        if (path) incoming.push(path);
      }
      if (incoming.length === 0) {
        // Some SDK shapes carry `item.path` directly — accept as fallback.
        const fallback = item ? asString(item.path) : null;
        if (fallback) incoming.push(fallback);
      }
      if (incoming.length === 0) return;
      const existing = useStore.getState().agents[id];
      if (!existing) return;
      const merged = mergeRecentFiles(existing.recentFiles, incoming);
      commands.updateAgent(id, { recentFiles: merged });
      return;
    }

    case 'agent_message': {
      const phase = asString(payload.phase);
      if (phase !== 'item.completed') return;
      const item = asObject(payload.item);
      const text = item ? asString(item.text) : null;
      if (!text) return;
      const existing = useStore.getState().agents[id];
      if (!existing) return;
      const nextTrail = [...existing.taskTrail, text].slice(-TASK_TRAIL_CAP);
      commands.updateAgent(id, {
        currentTask: text,
        taskTrail: nextTrail,
      });
      return;
    }

    case 'error': {
      // turn.failed / error item / stream error all flatten message into
      // payload.message OR payload.item.message. Prefer the flat one.
      const flatMessage = asString(payload.message);
      const itemMessage = (() => {
        const item = asObject(payload.item);
        return item ? asString(item.message) : null;
      })();
      const message = flatMessage ?? itemMessage ?? 'unknown_error';
      const existing = useStore.getState().agents[id];
      if (!existing) {
        console.warn('[ipcSync] codex error for unknown agent', id);
        return;
      }
      commands.blockAgent(id, message);
      return;
    }

    case 'agent_finished': {
      const existing = useStore.getState().agents[id];
      if (!existing) {
        console.warn('[ipcSync] agent_finished for unknown agent', id);
        return;
      }
      const aborted = payload.aborted === true;
      if (aborted) {
        commands.failAgent(id, 'aborted');
      } else {
        const summary = asString(payload.summary) ?? undefined;
        commands.completeAgent(id, summary);
      }
      return;
    }

    case 'reasoning':
    case 'command_execution':
    case 'tool_call':
    case 'turn_completed':
      // v1: noop. Surface in future passes if the Hive UI grows space for them.
      return;

    // ─── § P6.4 hang-watchdog ────────────────────────────────────────
    // The codex pool's hang watchdog (main/codex-pool-core.ts) emits
    // this synthetic event when an agent has produced no output for
    // longer than `DIRECTOR_HANG_THRESHOLD_MS` (default 60s). The
    // realtime layer separately gets a `tool.proactiveAnnounce` from
    // the planner; here we just stamp the agent card with a blocker so
    // the Hive UI surfaces the stuck state next to the agent.
    case 'agent_hang_suspected': {
      const existing = useStore.getState().agents[id];
      if (!existing) {
        console.warn('[ipcSync] hang_suspected for unknown agent', id);
        return;
      }
      const thresholdMs = (() => {
        const raw = payload.thresholdMs;
        return typeof raw === 'number' && raw > 0 ? raw : 60_000;
      })();
      const seconds = Math.round(thresholdMs / 1000);
      commands.updateAgent(id, {
        blocker: `watchdog: no output ${seconds}s`,
      });
      return;
    }

    // ─── § P6.5 batch-tracking ───────────────────────────────────────
    // The pool emits `batch_completed` after every agent in a
    // dispatched batch finishes. The Hive UI doesn't surface batch
    // state directly today; downstream consumers (worktree-merger)
    // pick this up via a separate subscription.
    case 'batch_completed':
      return;

    default: {
      console.warn('[ipcSync] unknown codex event type', event.type);
      return;
    }
  }
}

// ─── ask.show handler ────────────────────────────────────────────────────

/**
 * Default ask-user handler — bridges Director's `ask_user` tool into the
 * Mixtape sim. For the demo, the only ask the orchestration layer fires
 * is the Stripe-blocker resolution; treating any incoming answer as Jin's
 * resolution keeps the sim's `awaitingResolution` flag in lockstep with
 * the model's view of the world.
 *
 * If no orchestration layer is wired yet, this still works: the strip
 * acks instantly with `"timeout"` so the model isn't stuck.
 */
function handleAsk(payload: AskShowPayload): void {
  console.log('[ipcSync] ask.show', payload);
  const bridge = window.director;
  if (!bridge?.ask) {
    console.warn('[ipcSync] bridge.ask not available — cannot answer');
    return;
  }

  // Default answer policy for the Mixtape demo: route to resolveJinBlocker
  // if the user types/speaks into the strip later. For now we wait — the
  // dev `R` key (or the orchestration layer) will call resolveJinBlocker
  // which doesn't reach back here. The ask remains pending until either
  // the renderer fires an answer or the main-side 60s timeout elapses.
  void payload;
}

// ─── § session-resume (W3 — P6.3b) ───────────────────────────────────────
// Main fires `session.resumeAvailable` once on boot if a prior <7d-old
// session exists. We:
//   1. Append a transcript entry ("Pick up <name>, or start fresh?") so the
//      Captions overlay + chat-debug surface both reflect Director's
//      prompt verbatim. Marked `metadata.kind: 'proactive_announcement'`
//      so downstream renderers can style it differently (Pass 6 of UX).
//   2. Open the `options_picker` Canvas with two choices: Resume + Start
//      fresh. The Canvas component is interactive — its eventual response
//      will dispatch into the planner's first turn or seed a new session.
//
// Defensive: malformed payloads noop with a `console.warn`. Renderer never
// crashes on a bad session-resume event.

const RESUME_PICKER_COMPONENT_ID = 'session-resume-picker';

/**
 * Pure transformer exposed for unit tests. Builds the canvas args + the
 * transcript content for a given preview. Callers feed these into
 * `commands.appendTranscript` + `commands.openCanvas` respectively.
 */
export function buildResumePicker(
  preview: SessionResumeAvailablePayload['sessionPreview'],
): {
  question: string;
  canvasArgs: Parameters<typeof commands.openCanvas>[0];
} {
  const projectName =
    typeof preview?.projectName === 'string' && preview.projectName.length > 0
      ? preview.projectName
      : 'your last session';
  const goalSuffix =
    typeof preview?.currentGoal === 'string' && preview.currentGoal.length > 0
      ? ` Last goal: "${preview.currentGoal}".`
      : '';
  const question = `Pick up ${projectName}, or start fresh?${goalSuffix}`;
  return {
    question,
    canvasArgs: {
      componentId: RESUME_PICKER_COMPONENT_ID,
      component: 'options_picker',
      props: {
        title: 'Resume?',
        question,
        sessionId: preview?.sessionId ?? null,
        options: [
          { id: 'resume', label: `Pick up ${projectName}` },
          { id: 'fresh', label: 'Start fresh' },
        ],
      },
      interactive: true,
    },
  };
}

/** Last resume preview seen, so the canvas-response subscriber can map the
 *  picker choice back to the session id to hydrate. */
let pendingResumeSessionId: string | null = null;

export function handleSessionResumeAvailable(
  payload: SessionResumeAvailablePayload,
): void {
  if (!payload || typeof payload !== 'object') {
    console.warn('[ipcSync] dropping malformed session.resumeAvailable', payload);
    return;
  }
  if (payload.resumeAvailable !== true || !payload.sessionPreview) {
    console.warn(
      '[ipcSync] session.resumeAvailable without preview',
      payload,
    );
    return;
  }
  pendingResumeSessionId = payload.sessionPreview.sessionId ?? null;
  const { question, canvasArgs } = buildResumePicker(payload.sessionPreview);
  try {
    commands.appendTranscript({
      id: `session-resume-${Date.now()}`,
      role: 'assistant',
      content: question,
      timestamp: Date.now(),
      metadata: { kind: 'proactive_announcement' },
    });
  } catch (err) {
    console.warn('[ipcSync] resume transcript publish failed', err);
  }
  try {
    commands.openCanvas(canvasArgs);
  } catch (err) {
    console.warn('[ipcSync] resume canvas openCanvas failed', err);
  }
  // ─── § renderer-wireup (gap 6) ──────────────────────────────────────────
  // The strip store's openCanvas only mutates local state — to actually
  // surface the picker in the Canvas BrowserWindow we relay a canvas.render
  // through main. The response comes back via `canvas.user_response.relay`
  // (subscribed in initIpcSync → handleResumePickerResponse).
  try {
    window.director?.canvas?.render({
      component: canvasArgs.component,
      props: canvasArgs.props as Record<string, unknown>,
      component_id: canvasArgs.componentId,
    });
  } catch (err) {
    console.warn('[ipcSync] resume canvas relay failed', err);
  }
}

// ─── § renderer-wireup (gap 6) — resume picker response ──────────────────
// Handles the Canvas user_response for the resume picker. The options_picker
// emits `{ value: { option_id } }` or `{ value: { concept_id } }` depending
// on the component; we accept either and treat the literal ids "resume" /
// "fresh" defined in `buildResumePicker`. On "resume" we IPC to main to
// hydrate the prior session; on "fresh" we ack the boot-minted session.
export function handleResumePickerResponse(payload: {
  component_id: string;
  value: unknown;
}): void {
  if (payload?.component_id !== RESUME_PICKER_COMPONENT_ID) return;
  const value = payload.value;
  const choiceId =
    typeof value === 'object' && value !== null
      ? ((value as Record<string, unknown>).option_id ??
        (value as Record<string, unknown>).id ??
        (value as Record<string, unknown>).concept_id ??
        (value as Record<string, unknown>).action)
      : value;
  const choice = choiceId === 'resume' ? 'resume' : 'fresh';
  const bridge = window.director;
  if (!bridge?.session?.resume) {
    console.warn('[ipcSync] bridge.session.resume not exposed — cannot hydrate');
    return;
  }
  void bridge.session
    .resume({ choice, sessionId: choice === 'resume' ? pendingResumeSessionId : null })
    .then((res) => {
      if (!res.ok) {
        console.warn('[ipcSync] session.resume failed', res.error);
        return;
      }
      if (res.choice === 'resume' && res.goal) {
        commands.setGoal(res.goal);
      }
      console.log(`[ipcSync] session resolved choice=${res.choice}`);
    })
    .catch((err) => console.warn('[ipcSync] session.resume threw', err))
    .finally(() => {
      pendingResumeSessionId = null;
    });
}

// ─── Public init ─────────────────────────────────────────────────────────

let initialized = false;
const unsubscribers: Array<() => void> = [];

export function initIpcSync(): void {
  if (initialized) return;
  initialized = true;

  const bridge = window.director;
  if (!bridge) {
    console.warn('[ipcSync] window.director missing — non-Electron context?');
    return;
  }

  if (bridge.state?.onPatch) {
    unsubscribers.push(bridge.state.onPatch(applyPatch));
  } else {
    console.warn('[ipcSync] bridge.state.onPatch not exposed — patches dropped');
  }

  if (bridge.ask?.onShow) {
    unsubscribers.push(bridge.ask.onShow(handleAsk));
  } else {
    console.warn('[ipcSync] bridge.ask.onShow not exposed');
  }

  // § codex-event-bridge (W3 — P4)
  if (bridge.codex?.onEvent) {
    unsubscribers.push(bridge.codex.onEvent(handleCodexEvent));
  } else {
    console.warn('[ipcSync] bridge.codex.onEvent not exposed — codex events dropped');
  }

  // § session-resume (W3 — P6.3b)
  if (bridge.session?.onResumeAvailable) {
    unsubscribers.push(
      bridge.session.onResumeAvailable(handleSessionResumeAvailable),
    );
  } else {
    console.warn(
      '[ipcSync] bridge.session.onResumeAvailable not exposed — resume picker disabled',
    );
  }

  // ─── § renderer-wireup (gap 6) — canvas response router ─────────────────
  // Relayed canvas user_responses from main. Routes the resume-picker
  // response to its handler; other component responses fall through (the
  // onboarding form is handled by useOnboarding's own subscriber).
  if (bridge.canvas?.onUserResponse) {
    unsubscribers.push(
      bridge.canvas.onUserResponse((payload) => {
        handleResumePickerResponse(payload);
      }),
    );
  } else {
    console.warn(
      '[ipcSync] bridge.canvas.onUserResponse not exposed — resume picker response disabled',
    );
  }

  // § persistence-wiring (gap 5)
  initSnapshotPush();
}

// ─── § persistence-wiring (gap 5) ─────────────────────────────────────────
// Main keeps no full state mirror — it only pushes `state.patch` mutations
// to us. So the canonical renderer store is the source of truth for the
// on-disk `state.snapshot.json` + `meta.json`. We subscribe to the store
// and push a serialized snapshot to main on every meaningful mutation. The
// main-side writer (`side-store.ts § persistence-wiring`) is debounced 1.5s
// internally, so a leading-edge push per mutation is fine — no extra
// throttling needed here.
//
// Defensive: a missing bridge / push throw is swallowed; persistence is
// strictly best-effort and must never block UI updates.

function pushSnapshotNow(): void {
  const bridge = window.director;
  if (!bridge?.persistence?.pushSnapshot) return;
  try {
    const snapshot = useStore.getState().snapshot();
    bridge.persistence.pushSnapshot({ snapshot, goal: snapshot.goal });
  } catch (err) {
    console.warn('[ipcSync] snapshot push failed', err);
  }
}

function initSnapshotPush(): void {
  const bridge = window.director;
  if (!bridge?.persistence?.pushSnapshot) {
    console.warn(
      '[ipcSync] bridge.persistence.pushSnapshot not exposed — state persistence disabled',
    );
    return;
  }
  // Push an initial snapshot so a session that never mutates still gets a
  // meta header + baseline snapshot on disk.
  pushSnapshotNow();
  // Subscribe to every store change. zustand calls the listener after each
  // `set`; the main-side debounce coalesces the bursts.
  const unsub = useStore.subscribe(pushSnapshotNow);
  unsubscribers.push(unsub);
}

export function teardownIpcSync(): void {
  unsubscribers.forEach((off) => off());
  unsubscribers.length = 0;
  initialized = false;
}

/**
 * Answer the currently-pending ask via the bridge. Optionally also drives
 * the sim's `resolveJinBlocker` to keep the timeline aligned.
 */
export function answerAsk(askId: string, answer: string): void {
  const bridge = window.director;
  bridge?.ask?.answer({ ask_id: askId, answer });
  // The Mixtape demo's single ask is Jin's blocker — keep the sim aligned.
  resolveJinBlocker(answer);
}

/** Used in tests + dev tools. */
export function _statePatchForTest(payload: StatePatchPayload): void {
  applyPatch(payload);
}

// Convenience: a peek into the store for breakpoint debugging.
export function _snapshotForDebug(): unknown {
  return useStore.getState().snapshot();
}
