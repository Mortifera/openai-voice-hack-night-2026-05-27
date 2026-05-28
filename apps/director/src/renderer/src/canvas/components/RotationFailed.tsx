/**
 * RotationFailed — soft notice card rendered when realtime session rotation
 * fails repeatedly (per architecture.md §9 + remaining-phases §6.6).
 *
 * Auto-dismisses after ~1500ms. Dismissal goes through the existing
 * `canvas.user_response` flow — CanvasApp's `respond({ dismissed: true })`
 * handler triggers the auto-dismiss in main, which fires `canvas.dismiss`.
 * That path is functionally equivalent to the `commands.dismissCanvas`
 * call mentioned in the spec for the Strip-side Zustand store: the Canvas
 * window has its own lifecycle and we drive it via the same wire used by
 * the existing harness_rule_save flash.
 *
 * Pure presentational with a single timer side-effect. The component is
 * defensive: if the parent never wires `onAutoDismiss`, we still render
 * the message — no crash, no console noise beyond a single warn.
 */

import { useEffect, type JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export interface RotationFailedProps {
  /** Override timer for tests / longer-blip mode. Defaults to 1500ms. */
  autoDismissMs?: number;
  /** Caller-supplied dismiss callback (CanvasApp passes the wire respond). */
  onAutoDismiss?: () => void;
  /** Optional sub-text override. */
  message?: string;
}

const DEFAULT_AUTO_DISMISS_MS = 1500;

export function RotationFailed({
  autoDismissMs,
  onAutoDismiss,
  message,
}: RotationFailedProps = {}): JSX.Element {
  const reduced = useReducedMotion();
  const dismissDelay =
    typeof autoDismissMs === 'number' && Number.isFinite(autoDismissMs)
      ? Math.max(0, autoDismissMs)
      : DEFAULT_AUTO_DISMISS_MS;

  useEffect(() => {
    if (typeof onAutoDismiss !== 'function') return;
    const handle = window.setTimeout(() => {
      try {
        onAutoDismiss();
      } catch (err) {
        console.warn('[rotation-failed] onAutoDismiss threw', err);
      }
    }, dismissDelay);
    return () => window.clearTimeout(handle);
  }, [dismissDelay, onAutoDismiss]);

  const body =
    typeof message === 'string' && message.length > 0
      ? message
      : 'Session will reset in ~1s — sorry for the blip.';

  return (
    <motion.div
      className="canvas-degrade canvas-degrade--soft"
      role="status"
      aria-live="polite"
      initial={reduced ? { opacity: 1 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={
        reduced
          ? { duration: 0.12 }
          : { duration: 0.28, ease: [0.32, 0.72, 0, 1] }
      }
    >
      <span className="canvas-eyebrow">Reconnecting</span>
      <p className="canvas-degrade-body">{body}</p>
    </motion.div>
  );
}
