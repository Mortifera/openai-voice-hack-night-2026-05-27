/**
 * CanvasError — fallback card rendered by the CanvasErrorBoundary when any
 * Canvas component's render throws. Surfaces a short error label + a
 * retry button that re-mounts the previous payload via the boundary's
 * reset callback.
 *
 * Per docs/remaining-phases.md §6.6 (W5 lane) + architecture.md §9.
 *
 * Pure presentational. Receives a normalized error message (never the raw
 * Error object) so React can serialize the props cleanly for snapshot tests.
 */

import type { JSX } from 'react';

export interface CanvasErrorProps {
  /** Human-readable error message. Falls back to a generic line. */
  message?: string;
  /** Component name that threw, if known. Surfaced for debugging. */
  componentName?: string;
  /** Boundary-supplied retry hook. If absent, the button is hidden. */
  onRetry?: () => void;
}

export function CanvasError({
  message,
  componentName,
  onRetry,
}: CanvasErrorProps = {}): JSX.Element {
  const safeMessage =
    typeof message === 'string' && message.length > 0
      ? message
      : 'Something went wrong rendering this card.';
  const safeComponent =
    typeof componentName === 'string' && componentName.length > 0
      ? componentName
      : null;

  return (
    <div className="canvas-degrade canvas-degrade--error" role="alert">
      <span className="canvas-eyebrow">Canvas error</span>
      <div className="canvas-title">Couldn&rsquo;t draw that.</div>
      <p className="canvas-degrade-body" data-no-drag>
        {safeMessage}
      </p>
      {safeComponent ? (
        <span className="artifact-meta" data-no-drag>
          component · {safeComponent}
        </span>
      ) : null}
      {typeof onRetry === 'function' ? (
        <button
          type="button"
          className="canvas-degrade-button"
          data-no-drag
          onClick={() => {
            try {
              onRetry();
            } catch (err) {
              console.warn('[canvas-error] retry threw', err);
            }
          }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
