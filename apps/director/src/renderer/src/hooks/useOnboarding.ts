/**
 * useOnboarding — minimal-seed first-launch onboarding (P5.3).
 *
 * On first mount, opens the Canvas with a Form component asking for:
 *   - projectPath (text)
 *   - voice       (marin | cedar)
 *   - apiKey      (password)
 *
 * On submit:
 *   - Stores a renderer-side flag in localStorage so we don't show again
 *     after a relaunch (hackathon proxy — until W3's resume-on-launch path
 *     supplies an authoritative `~/.director/sessions/` check via IPC).
 *   - Tries to push a session.update to the Realtime client with the chosen
 *     voice; the apiKey + projectPath are forwarded to main via a synthetic
 *     tool.call (best effort — handled by W3's tool-router or noop'd).
 *   - Triggers Director to speak the canonical greeting:
 *       "Ready. What are we building?"
 *
 * Spec: docs/remaining-phases.md § 5.3 ("Minimal-seed onboarding (3A-1)").
 *
 * Gating (per open Q #5):
 *   - Fires when `localStorage[ONBOARDING_KEY]` is unset.
 *   - Once submitted, the flag flips and future launches skip it.
 *   - `DIRECTOR_FORCE_ONBOARDING=1` in import.meta.env overrides for QA.
 *
 * Defensive: every IPC / send call is guarded — if main isn't listening,
 * the renderer still completes onboarding and unblocks the user.
 */

import { useEffect, useRef } from 'react';
import type { RealtimeClient } from '../realtime/client.js';
import { commands } from '../state/store.js';

const ONBOARDING_KEY = 'director.onboarded.v1';
const COMPONENT_ID = 'director-onboarding';
const GREETING = 'Ready. What are we building?';

interface OnboardingValues {
  projectPath?: string;
  voice?: string;
  apiKey?: string;
}

function shouldShowOnboarding(): boolean {
  if (typeof window === 'undefined') return false;
  // QA / forced replay override.
  const meta = (import.meta as { env?: Record<string, string> }).env;
  if (meta && meta.DIRECTOR_FORCE_ONBOARDING === '1') return true;
  try {
    return window.localStorage.getItem(ONBOARDING_KEY) == null;
  } catch {
    // Private mode / disabled storage — be conservative and skip.
    return false;
  }
}

function markOnboarded(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ONBOARDING_KEY, String(Date.now()));
  } catch {
    // Storage unavailable — fine, in-memory ref below prevents reopens.
  }
}

function speakGreeting(client: RealtimeClient): void {
  if (client.status !== 'connected' || !client.dcReady) {
    // Realtime not up yet — queue a one-shot retry when it lands.
    const off = client.on('status', (next) => {
      if (next === 'connected') {
        off();
        // Slight delay so the data channel has time to open after status flip.
        window.setTimeout(() => trySpeak(client), 100);
      }
    });
    return;
  }
  trySpeak(client);
}

function trySpeak(client: RealtimeClient): void {
  if (!client.dcReady) return;
  client.send({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: `Greet the user with exactly: "${GREETING}" Be terse — no preamble.`,
        },
      ],
    },
  });
  client.send({ type: 'response.create' });
}

// ─── § renderer-wireup (gap 8) ──────────────────────────────────────────
// Persist the real form values (projectPath, voice, apiKey) to the side
// store + .env via the main-process `app.onboardingComplete` handler.
function sendOnboardingComplete(values: OnboardingValues): void {
  if (typeof window === 'undefined') return;
  const bridge = window.director;
  if (!bridge?.app?.onboardingComplete) {
    console.warn('[useOnboarding] bridge.app.onboardingComplete not exposed');
    return;
  }
  void bridge.app
    .onboardingComplete({
      projectPath: values.projectPath ?? null,
      voice: values.voice ?? 'marin',
      apiKey: values.apiKey ?? null,
    })
    .then((res) => {
      if (!res.ok) {
        console.warn('[useOnboarding] onboardingComplete failed', res.error);
      } else {
        console.log('[useOnboarding] onboarding persisted →', res.sessionDir);
      }
    })
    .catch((err) => {
      console.warn('[useOnboarding] app.onboardingComplete threw', err);
    });
}

/** Extract typed form values from a Canvas form user_response payload. The
 *  Form component emits `{ value: { values: { ... } } }`. */
function extractFormValues(value: unknown): OnboardingValues {
  const outer =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const inner =
    typeof outer.values === 'object' && outer.values !== null
      ? (outer.values as Record<string, unknown>)
      : outer;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  return {
    projectPath: str(inner.projectPath),
    voice: str(inner.voice),
    apiKey: str(inner.apiKey),
  };
}

export function useOnboarding(client: RealtimeClient): void {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    if (!shouldShowOnboarding()) return;
    fired.current = true;

    const formArgs = {
      componentId: COMPONENT_ID,
      component: 'form' as const,
      props: {
        title: 'Welcome to Director',
        submitLabel: 'Start',
      },
      interactive: true,
    };
    // Local store (drives strip-side canvas selectors).
    commands.openCanvas(formArgs);
    // ─── § renderer-wireup (gap 8) ──────────────────────────────────────
    // Also surface the form in the real Canvas BrowserWindow via the relay.
    window.director?.canvas?.render({
      component: formArgs.component,
      props: formArgs.props,
      component_id: formArgs.componentId,
    });
  }, []);

  // ─── § renderer-wireup (gap 8) — read real form values from the Canvas ──
  // The Canvas window's Form emits `canvas.user_response` with the submitted
  // values; main relays it here. We extract { projectPath, voice, apiKey },
  // persist via app.onboardingComplete, mark onboarded, and greet.
  useEffect(() => {
    const bridge = window.director;
    if (!bridge?.canvas?.onUserResponse) return;
    const off = bridge.canvas.onUserResponse((payload) => {
      if (payload.component_id !== COMPONENT_ID) return;
      const values = extractFormValues(payload.value);
      markOnboarded();
      sendOnboardingComplete(values);
      speakGreeting(client);
    });
    return off;
  }, [client]);
}
