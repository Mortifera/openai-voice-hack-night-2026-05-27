/**
 * UnknownComponent — fallback for canvas.render payloads we don't yet have
 * a dedicated renderer for. Shows the requested component name plus a
 * pretty-printed JSON view of the props for debugging.
 *
 * Used for: `options_picker`, `form`, `code_preview`, `diagram`, `agent_pod`,
 * `html_escape`, and anything else not explicitly mapped in CanvasApp.tsx.
 */

import type { JSX } from 'react';

export function UnknownComponent({
  component,
  props,
}: {
  component: string;
  props: Record<string, unknown>;
}): JSX.Element {
  return (
    <div className="canvas-unknown">
      <span className="canvas-eyebrow">Canvas · debug</span>
      <div className="canvas-title">
        {`"${component}" not yet implemented`}
      </div>
      <pre className="canvas-unknown-json" data-no-drag>
        {JSON.stringify(props, null, 2)}
      </pre>
    </div>
  );
}
