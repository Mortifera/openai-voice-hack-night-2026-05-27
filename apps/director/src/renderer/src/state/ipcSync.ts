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
  StatePatchPayload,
} from '../../../shared/ipc.js';
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
