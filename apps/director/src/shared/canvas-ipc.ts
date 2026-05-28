/**
 * Canvas IPC — channel names + payload types for the Canvas BrowserWindow.
 *
 * Channel naming follows W3's tool-router convention (`<domain>.<action>`):
 *   - `canvas.render`         main → canvas-window: render a component
 *   - `canvas.dismiss`        main → canvas-window: animate out + hide
 *   - `canvas.user_response`  canvas-window → main: user interaction commit
 *
 * `canvas.render` and `canvas.dismiss` can also be sent from anywhere in
 * the main process (W3's tool-router) via `ipcMain.emit`, in which case
 * canvas.ts forwards the same payload to the live canvas window.
 *
 * See: docs/ux-design.md Pass 1 (slide-in geometry), Pass 5 (radius/shadow).
 *      docs/research/genui-schema.md (component shapes).
 */

/**
 * Local type subset — mirrors `state.ts` (W3). Inlined so this file can land
 * without depending on W3's state-machine commits. `string` widens the union
 * so the router can fall through to an "unknown component" preview rather
 * than reject. Known names match docs/research/genui-schema.md.
 */
export type CanvasKnownComponent =
  | 'moodboard'
  | 'options_picker'
  | 'diagram'
  | 'code_preview'
  | 'form'
  | 'agent_pod'
  | 'artifact_preview'
  | 'html_escape'
  | 'harness_flash'
  | 'harness_rule_save';

export type CanvasComponentName = CanvasKnownComponent | string;

export type CanvasComponentProps = Record<string, unknown>;

export const CanvasIpcChannel = {
  /** Main → canvas-window OR ipcMain entry-point: render a component. */
  Render: 'canvas.render',
  /** Main → canvas-window OR ipcMain entry-point: dismiss the canvas. */
  Dismiss: 'canvas.dismiss',
  /** Canvas-window → main: user committed an interaction. */
  UserResponse: 'canvas.user_response',
} as const;

export type CanvasIpcChannel =
  (typeof CanvasIpcChannel)[keyof typeof CanvasIpcChannel];

/** Payload for {@link CanvasIpcChannel.Render}. */
export interface CanvasRenderPayload {
  component: CanvasComponentName;
  props: CanvasComponentProps;
  /** Stable id used to correlate user_response back to this render. */
  component_id?: string;
  /** Tool-call id when triggered through W3's tool router. */
  call_id?: string;
  /** Auto-dismiss timeout (ms). For ephemeral cards like harness_rule_save. */
  autoDismissMs?: number;
}

/** Payload for {@link CanvasIpcChannel.Dismiss}. */
export interface CanvasDismissPayload {
  component_id?: string;
}

/** Payload for {@link CanvasIpcChannel.UserResponse}. */
export interface CanvasUserResponsePayload {
  component_id: string;
  value: unknown;
  call_id?: string;
}
