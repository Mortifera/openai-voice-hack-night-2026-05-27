/**
 * Canvas BrowserWindow — second, transparent, vibrant overlay window that
 * holds the GenUI Canvas (Moodboard / ArtifactPreview / HarnessRuleSave / …).
 *
 * Process model: a fully separate `BrowserWindow` from the Strip. Hidden by
 * default; opens when W3's tool-router emits `canvas.render` (or any other
 * main-process caller invokes `renderCanvas()` directly). Tray + global
 * lifecycle live in `main/index.ts`; this module owns the window object and
 * its IPC surface.
 *
 * Geometry (Pass 1, Pass 5):
 *   - 580×480 right-edge slab. Positioned just LEFT of the Strip's bounds
 *     when a strip window has been registered (see `setStripWindow`);
 *     otherwise falls back to a fixed offset from the screen's right edge.
 *   - 22px corner radius, 0.5px hairline border, soft shadow.
 *   - `vibrancy: 'under-window'` + `transparent: true` + `frame: false`.
 *   - `alwaysOnTop: 'screen-saver'` so it floats above fullscreen apps.
 */

import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import { is } from '@electron-toolkit/utils';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CanvasIpcChannel,
  type CanvasDismissPayload,
  type CanvasRenderPayload,
  type CanvasUserResponsePayload,
} from '../shared/canvas-ipc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const CANVAS_WIDTH = 580;
const CANVAS_HEIGHT = 480;
const CANVAS_EDGE_OFFSET = 20; // gap when no strip is registered
const STRIP_CANVAS_GAP = 8; // gap between Canvas right edge and Strip left edge
const DISMISS_ANIMATION_MS = 260; // matches --duration-base
const RESPONSE_AUTO_DISMISS_MS = 400; // Pass 2 §Canvas dismissing

let canvasWindow: BrowserWindow | null = null;
let stripWindowRef: BrowserWindow | null = null;
let onUserResponse: ((payload: CanvasUserResponsePayload) => void) | null =
  null;

/**
 * Allow `main/index.ts` to hand us the Strip's BrowserWindow so we can
 * position the Canvas relative to its current bounds (and re-position when
 * the Strip moves/resizes).
 */
export function setStripWindow(window: BrowserWindow | null): void {
  if (stripWindowRef === window) return;
  stripWindowRef = window;

  if (window) {
    const reposition = (): void => {
      if (!canvasWindow || canvasWindow.isDestroyed()) return;
      if (!canvasWindow.isVisible()) return;
      canvasWindow.setBounds(computeCanvasBounds());
    };
    window.on('move', reposition);
    window.on('resize', reposition);
    window.on('closed', () => {
      if (stripWindowRef === window) stripWindowRef = null;
    });
  }
}

function computeCanvasBounds(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  // Prefer positioning relative to the Strip — Canvas sits just to its left.
  if (stripWindowRef && !stripWindowRef.isDestroyed()) {
    const strip = stripWindowRef.getBounds();
    const x = strip.x - CANVAS_WIDTH - STRIP_CANVAS_GAP;
    const stripCenterY = strip.y + Math.round(strip.height / 2);
    const y = stripCenterY - Math.round(CANVAS_HEIGHT / 2);
    return { x, y, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
  }

  // Fallback: right edge of primary display.
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const x =
    workArea.x + workArea.width - CANVAS_WIDTH - CANVAS_EDGE_OFFSET - 12;
  const y = workArea.y + Math.round((workArea.height - CANVAS_HEIGHT) / 2);
  return { x, y, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
}

export function createCanvasWindow(): BrowserWindow {
  if (canvasWindow && !canvasWindow.isDestroyed()) {
    return canvasWindow;
  }

  const bounds = computeCanvasBounds();

  canvasWindow = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    type: 'panel',
    webPreferences: {
      preload: join(__dirname, '../preload/canvas.mjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  canvasWindow.setAlwaysOnTop(true, 'screen-saver');
  canvasWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Hide on close instead of destroying — lets us reopen instantly.
  canvasWindow.on('close', (event) => {
    if (canvasWindow && !canvasWindow.isDestroyed()) {
      event.preventDefault();
      canvasWindow.hide();
    }
  });

  // Click-outside dismiss: when the canvas window loses focus, animate out.
  // Voice flow may want to keep it open; for v1 we just dismiss.
  canvasWindow.on('blur', () => {
    if (canvasWindow && canvasWindow.isVisible()) {
      dismissCanvas();
    }
  });

  // Re-anchor on display changes.
  const reanchor = (): void => {
    if (canvasWindow && !canvasWindow.isDestroyed()) {
      canvasWindow.setBounds(computeCanvasBounds());
    }
  };
  screen.on('display-metrics-changed', reanchor);
  screen.on('display-added', reanchor);
  screen.on('display-removed', reanchor);
  canvasWindow.on('closed', () => {
    screen.off('display-metrics-changed', reanchor);
    screen.off('display-added', reanchor);
    screen.off('display-removed', reanchor);
    canvasWindow = null;
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    canvasWindow.loadURL(
      `${process.env['ELECTRON_RENDERER_URL']}/canvas.html`,
    );
  } else {
    canvasWindow.loadFile(join(__dirname, '../renderer/canvas.html'));
  }

  return canvasWindow;
}

/**
 * Render a component in the Canvas. The tool-router (W3) and dev hotkeys
 * (main/index.ts) both call this. The same channel name is also accepted
 * via ipcMain.on so renderer-side callers can drive Canvas directly.
 */
export function renderCanvas(payload: CanvasRenderPayload): void {
  const window = createCanvasWindow();
  // Re-anchor immediately before showing so we land in the right spot.
  window.setBounds(computeCanvasBounds());

  const dispatch = (): void => {
    window.webContents.send(CanvasIpcChannel.Render, payload);
    if (!window.isVisible()) window.show();
    window.focus();
  };
  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', dispatch);
  } else {
    dispatch();
  }
}

export function dismissCanvas(payload?: CanvasDismissPayload): void {
  if (!canvasWindow || canvasWindow.isDestroyed()) return;
  if (!canvasWindow.isVisible()) return;
  canvasWindow.webContents.send(CanvasIpcChannel.Dismiss, payload ?? {});
  // Give the renderer the slide-out window before hiding.
  setTimeout(() => {
    if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.hide();
  }, DISMISS_ANIMATION_MS);
}

/**
 * Register IPC handlers. Call once from `app.whenReady()` in main/index.ts.
 *
 * @param handler Optional callback invoked on each user_response. If absent,
 *                the payload is logged. The auto-dismiss (~400ms) fires
 *                whether or not a handler is provided.
 */
export function registerCanvasIpc(
  handler?: (payload: CanvasUserResponsePayload) => void,
): void {
  onUserResponse = handler ?? null;

  // Accept render/dismiss commands from any main-process source (W3's tool
  // router) via the same channel names. ipcMain.on also catches synthetic
  // emits via `ipcMain.emit(channel, null, payload)`.
  ipcMain.on(
    CanvasIpcChannel.Render,
    (_evt: IpcMainEvent, payload: CanvasRenderPayload) => {
      renderCanvas(payload);
    },
  );

  ipcMain.on(
    CanvasIpcChannel.Dismiss,
    (_evt: IpcMainEvent, payload?: CanvasDismissPayload) => {
      dismissCanvas(payload);
    },
  );

  ipcMain.on(
    CanvasIpcChannel.UserResponse,
    (_evt: IpcMainEvent, payload: CanvasUserResponsePayload) => {
      if (onUserResponse) {
        onUserResponse(payload);
      } else {
        console.log(
          `[canvas] user_response component_id=${payload.component_id} ` +
            `call_id=${payload.call_id ?? '-'} value=`,
          payload.value,
        );
      }
      // Auto-dismiss 400ms after the response per Pass 2.
      setTimeout(() => dismissCanvas(), RESPONSE_AUTO_DISMISS_MS);
    },
  );
}

export function getCanvasWindow(): BrowserWindow | null {
  return canvasWindow && !canvasWindow.isDestroyed() ? canvasWindow : null;
}

export const CANVAS_ASSETS_DIR = resolve(
  __dirname,
  '..',
  'renderer',
  'src',
  'assets',
);
