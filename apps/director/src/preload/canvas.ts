/**
 * Canvas-window preload — exposes a minimal IPC surface for the Canvas
 * BrowserWindow's renderer. Lives separately from the Strip preload (W1)
 * so the two surfaces evolve independently.
 *
 * Exposes `window.canvasIpc` with on/off/send for Canvas-specific channels.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CanvasIpcChannel } from '../shared/canvas-ipc.js';

type Listener = (...args: unknown[]) => void;

const SAFE_CHANNELS = new Set<string>(Object.values(CanvasIpcChannel));

const api = {
  on(channel: string, listener: Listener): void {
    if (!SAFE_CHANNELS.has(channel)) {
      console.warn(`[canvas:preload] refusing on(${channel})`);
      return;
    }
    ipcRenderer.on(
      channel,
      (event: IpcRendererEvent, ...args: unknown[]) =>
        listener(event, ...args),
    );
  },
  removeListener(channel: string, _listener: Listener): void {
    if (!SAFE_CHANNELS.has(channel)) return;
    // For simplicity (and because each window keeps a single listener per
    // channel), drop all listeners on this channel. Safe in this surface.
    ipcRenderer.removeAllListeners(channel);
  },
  send(channel: string, ...args: unknown[]): void {
    if (!SAFE_CHANNELS.has(channel)) {
      console.warn(`[canvas:preload] refusing send(${channel})`);
      return;
    }
    ipcRenderer.send(channel, ...args);
  },
};

if (process.contextIsolated) {
  try {
    // Mirror the shape CanvasApp.tsx looks for first.
    contextBridge.exposeInMainWorld('electron', { ipcRenderer: api });
    contextBridge.exposeInMainWorld('director', { canvasIpc: api });
  } catch (err) {
    console.error('[canvas:preload] failed to expose bridge', err);
  }
} else {
  (window as unknown as { electron: { ipcRenderer: typeof api } }).electron = {
    ipcRenderer: api,
  };
}
