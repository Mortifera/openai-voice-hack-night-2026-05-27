/**
 * Canvas BrowserWindow — second, transparent, vibrant overlay window that
 * holds the GenUI Canvas (Moodboard / ArtifactPreview / HarnessRuleSave / …).
 *
 * Process model: a fully separate `BrowserWindow` from the Strip. Hidden by
 * default; opens when the Realtime layer issues `render_canvas` and the
 * renderer requests `canvas.open`. Tray + global lifecycle are owned by
 * `main/index.ts`; this module just owns the window object + its IPC surface.
 *
 * Geometry (Pass 1, Pass 5):
 *   - ~580×480 right-edge slab, vertically centered, 20px from screen edge.
 *   - 22px corner radius (radius-canvas), 0.5px hairline border, soft shadow.
 *   - `vibrancy: 'under-window'` + `transparent: true` + `frame: false`.
 *   - `alwaysOnTop: 'screen-saver'` so it sits above fullscreen apps.
 */

import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import { is } from '@electron-toolkit/utils';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CanvasIpcChannel,
  type CanvasShowPayload,
  type CanvasResponsePayload,
} from '../shared/canvas-ipc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const CANVAS_WIDTH = 580;
const CANVAS_HEIGHT = 480;
const CANVAS_EDGE_OFFSET = 20;
// Reserve space for the Strip handle on the canvas's left edge (Pass 1).
const STRIP_HANDLE_GAP = 40;

let canvasWindow: BrowserWindow | null = null;

function computeCanvasBounds(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const x =
    workArea.x +
    workArea.width -
    CANVAS_WIDTH -
    CANVAS_EDGE_OFFSET -
    STRIP_HANDLE_GAP;
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
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    titleBarStyle: 'hidden',
    type: 'panel',
    webPreferences: {
      // Canvas-specific preload — exposes window.electron.ipcRenderer for
      // CanvasApp's show/dismiss/response wiring.
      preload: join(__dirname, '../preload/canvas.mjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Persist across reopens — no flash of empty content.
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

  // Re-anchor if displays change.
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
    // electron-vite dev server: load the second HTML entry.
    canvasWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/canvas.html`);
  } else {
    canvasWindow.loadFile(join(__dirname, '../renderer/canvas.html'));
  }

  return canvasWindow;
}

export function showCanvas(payload: CanvasShowPayload): void {
  const window = createCanvasWindow();
  // Wait for the renderer to be ready before sending the show event.
  const dispatch = (): void => {
    window.webContents.send(CanvasIpcChannel.Show, payload);
    if (!window.isVisible()) window.show();
  };
  if (window.webContents.isLoading()) {
    window.webContents.once('did-finish-load', dispatch);
  } else {
    dispatch();
  }
}

export function dismissCanvas(): void {
  if (!canvasWindow || canvasWindow.isDestroyed()) return;
  canvasWindow.webContents.send(CanvasIpcChannel.Dismiss);
  // Give the renderer the slide-out window before hiding.
  setTimeout(() => {
    if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.hide();
  }, 260);
}

/**
 * Register IPC handlers for canvas open/close/response. Call once from
 * `app.whenReady()` in `main/index.ts`.
 */
export function registerCanvasIpc(
  onResponse?: (payload: CanvasResponsePayload) => void,
): void {
  ipcMain.on(
    CanvasIpcChannel.Open,
    (_evt: IpcMainEvent, payload: CanvasShowPayload) => {
      showCanvas(payload);
    },
  );

  ipcMain.on(CanvasIpcChannel.Close, () => {
    dismissCanvas();
  });

  ipcMain.on(
    CanvasIpcChannel.Response,
    (_evt: IpcMainEvent, payload: CanvasResponsePayload) => {
      // Surface back up to whoever cares (orchestrator/W1 wiring).
      if (onResponse) onResponse(payload);
      else
        console.log(
          `[canvas] response component_id=${payload.componentId} value=`,
          payload.value,
        );
      // Match the spec: auto-dismiss 400ms after a response.
      setTimeout(() => dismissCanvas(), 400);
    },
  );
}

/**
 * Internal: returns the live canvas window (or null). Exposed for the dev
 * keystroke wiring in main/index.ts.
 */
export function getCanvasWindow(): BrowserWindow | null {
  return canvasWindow && !canvasWindow.isDestroyed() ? canvasWindow : null;
}

// Resolve the assets directory at runtime so renderer code paths line up.
export const CANVAS_ASSETS_DIR = resolve(
  __dirname,
  '..',
  'renderer',
  'src',
  'assets',
);
