/**
 * Canvas-window preload — narrow IPC surface for the Canvas BrowserWindow's
 * renderer. Lives separately from the Strip preload (W1) so the two surfaces
 * evolve independently.
 *
 * Exposes `window.electron.ipcRenderer` (and a `director.canvasIpc` mirror)
 * with on / removeListener / send constrained to canvas channels.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CanvasIpcChannel } from '../shared/canvas-ipc.js';
// ─── § canvas-degradation (W5 — P6.6) ───────────────────────────────────
import {
  IpcChannel,
  type AppWriteEnvRequest,
  type AppWriteEnvResponse,
} from '../shared/ipc.js';

type Listener = (...args: unknown[]) => void;
type IpcListener = (event: IpcRendererEvent, ...args: unknown[]) => void;

const SAFE_CHANNELS = new Set<string>(Object.values(CanvasIpcChannel));

/**
 * Per-channel registry of (caller listener) → (wrapped listener we passed to
 * ipcRenderer). Lets removeListener target the SPECIFIC wrapped listener
 * instead of dropping every subscriber on the channel — prior implementation
 * called ipcRenderer.removeAllListeners(channel), which would deregister
 * any other subscriber on the same channel.
 */
const wrappers = new Map<string, WeakMap<Listener, IpcListener>>();

function trackWrapper(channel: string, original: Listener, wrapped: IpcListener): void {
  let perChannel = wrappers.get(channel);
  if (!perChannel) {
    perChannel = new WeakMap();
    wrappers.set(channel, perChannel);
  }
  perChannel.set(original, wrapped);
}

function popWrapper(channel: string, original: Listener): IpcListener | undefined {
  const perChannel = wrappers.get(channel);
  const wrapped = perChannel?.get(original);
  perChannel?.delete(original);
  return wrapped;
}

const api = {
  on(channel: string, listener: Listener): void {
    if (!SAFE_CHANNELS.has(channel)) {
      console.warn(`[canvas:preload] refusing on(${channel})`);
      return;
    }
    const wrapped: IpcListener = (event, ...args) => listener(event, ...args);
    trackWrapper(channel, listener, wrapped);
    ipcRenderer.on(channel, wrapped);
  },
  removeListener(channel: string, listener: Listener): void {
    if (!SAFE_CHANNELS.has(channel)) return;
    const wrapped = popWrapper(channel, listener);
    if (wrapped) {
      ipcRenderer.removeListener(channel, wrapped);
    }
  },
  send(channel: string, ...args: unknown[]): void {
    if (!SAFE_CHANNELS.has(channel)) {
      console.warn(`[canvas:preload] refusing send(${channel})`);
      return;
    }
    ipcRenderer.send(channel, ...args);
  },
};

// ─── § canvas-degradation (W5 — P6.6) ───────────────────────────────────
// Narrow `director.app.writeEnv` bridge for the ApiKeyMissing card. Single
// IPC channel exposed via invoke — main owns the file write, the canvas
// renderer never touches `fs` directly.
const appApi = {
  writeEnv(req: AppWriteEnvRequest): Promise<AppWriteEnvResponse> {
    return ipcRenderer.invoke(IpcChannel.AppWriteEnv, req);
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', { ipcRenderer: api });
    contextBridge.exposeInMainWorld('director', {
      canvasIpc: api,
      // § canvas-degradation (W5 — P6.6)
      app: appApi,
    });
  } catch (err) {
    console.error('[canvas:preload] failed to expose bridge', err);
  }
} else {
  (
    window as unknown as {
      electron: { ipcRenderer: typeof api };
      director: { canvasIpc: typeof api; app: typeof appApi };
    }
  ).electron = { ipcRenderer: api };
  (
    window as unknown as {
      director: { canvasIpc: typeof api; app: typeof appApi };
    }
  ).director = { canvasIpc: api, app: appApi };
}
