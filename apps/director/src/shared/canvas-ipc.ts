/**
 * Canvas IPC — channel names + payload types for the Canvas BrowserWindow.
 *
 * Kept in a dedicated file (rather than `ipc.ts`) so W4's canvas wiring can
 * land without colliding with the broader IPC contract owned by W3. The
 * canonical IPC enum can re-export or absorb these later.
 *
 * See: docs/ux-design.md Pass 1 (slide-in geometry), Pass 5 (radius-canvas:22).
 *      docs/research/genui-schema.md (component shapes).
 */

/**
 * Local type subset — mirrors `state.ts` (W3). Inlined so this file can land
 * without depending on W3's state-machine commits. If state.ts's
 * `CanvasComponentName` evolves, re-root via a re-export here.
 */
export type CanvasComponentName =
  | 'moodboard'
  | 'options_picker'
  | 'diagram'
  | 'code_preview'
  | 'form'
  | 'agent_pod'
  | 'artifact_preview'
  | 'html_escape'
  | 'harness_flash';

export type CanvasComponentProps = Record<string, unknown>;

export const CanvasIpcChannel = {
  /** Main → renderer (canvas window): "render this component now". */
  Show: 'director:canvas-show',
  /** Main → renderer (canvas window): "dismiss whatever's showing". */
  Dismiss: 'director:canvas-dismiss',
  /** Renderer (strip) → main: "open the canvas with this content". */
  Open: 'director:canvas-open',
  /** Renderer (strip or canvas) → main: "close the canvas". */
  Close: 'director:canvas-close',
  /** Renderer (canvas) → main: user responded (click / voice resolution). */
  Response: 'director:canvas-response',
} as const;

export type CanvasIpcChannel =
  (typeof CanvasIpcChannel)[keyof typeof CanvasIpcChannel];

/** Payload for {@link CanvasIpcChannel.Show} and {@link CanvasIpcChannel.Open}. */
export interface CanvasShowPayload {
  componentId: string;
  component: CanvasComponentName;
  props: CanvasComponentProps;
  /** Auto-dismiss timeout (ms). For e.g. harness_flash card. */
  autoDismissMs?: number;
}

export interface CanvasResponsePayload {
  componentId: string;
  value: unknown;
}

/**
 * Subset of {@link CanvasShowPayload} the canvas renderer exposes to React.
 * (Identical for now; kept named so we can diverge cleanly.)
 */
export type CanvasRenderEnvelope = CanvasShowPayload;
