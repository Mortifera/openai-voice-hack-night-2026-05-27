import { useEffect } from 'react';
import { commands, useStore } from '../state/store.js';

/**
 * Subscribes to main-process `planner.reasoning.delta` IPC events and
 * appends each delta into the store's thinkingTrail so the Strip displays
 * it as a fading reasoning trail (Pencil frame TiVyu). On the first delta
 * we transition the strip into 'thinking'; an idle-quiet timer drops it
 * back to its prior state if no further deltas arrive.
 *
 * NOTE: `window.director.planner` is not yet exposed by the preload bridge
 * (Worker 1 owns that surface; see shared/ipc.ts `PlannerReasoningDelta`
 * channel). Until that namespace is added, this hook is a defensive no-op
 * — it lights up automatically once `bridge.planner.onReasoningDelta`
 * exists. Mounted from App.tsx by Worker 4 per docs/contracts.md § 13.2.
 */

type PlannerBridge = {
  onReasoningDelta?: (cb: (text: string) => void) => () => void;
};

type MaybePlannerWindow = {
  director?: { planner?: PlannerBridge };
};

const QUIET_MS = 4000;

export function usePlannerNarration(): void {
  useEffect(() => {
    const bridge = (window as unknown as MaybePlannerWindow).director;
    const onDelta = bridge?.planner?.onReasoningDelta;
    if (typeof onDelta !== 'function') {
      // Preload bridge does not yet expose `planner.onReasoningDelta`.
      // No-op; this hook lights up once Worker 1 adds the namespace.
      return;
    }

    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let active = false;

    const off = onDelta((text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (!active) {
        active = true;
        const kind = useStore.getState().strip.kind;
        // Only force into thinking from a quiet-ish state; never clobber
        // an in-flight speaking turn.
        if (kind === 'dormant' || kind === 'listening' || kind === 'hive') {
          commands.setThinking();
        }
      }

      commands.appendThinkingTrail(trimmed);

      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        active = false;
        quietTimer = null;
      }, QUIET_MS);
    });

    return () => {
      if (quietTimer) clearTimeout(quietTimer);
      off();
    };
  }, []);
}
