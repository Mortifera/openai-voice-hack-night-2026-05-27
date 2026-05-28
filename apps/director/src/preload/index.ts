console.log('[preload] script loaded', {
  contextIsolated: process.contextIsolated,
  sandboxed: process.sandboxed,
});

import { contextBridge, ipcRenderer } from 'electron';
import {
  IpcChannel,
  type AskAnswerPayload,
  type AskShowPayload,
  type DirectorBridge,
  type DormantState,
  type HotkeyListener,
  type ToolCallRequest,
  type ToolCallResponse,
  type ToolResultPayload,
  type MicStatusPayload,
  type StatePatchPayload,
  type StripResizeRequest,
  type StripResizeResponse,
} from '../shared/ipc.js';
import type {
  RealtimeEphemeralToken,
  RealtimeSessionRequest,
} from '../shared/realtime.js';

const api: DirectorBridge = {
  onHotkey(cb: HotkeyListener) {
    const listener = (): void => cb();
    ipcRenderer.on(IpcChannel.HotkeyPressed, listener);
    return () => ipcRenderer.removeListener(IpcChannel.HotkeyPressed, listener);
  },
  requestSummon(): Promise<void> {
    return ipcRenderer.invoke(IpcChannel.RequestSummon);
  },
  getDormantState(): Promise<DormantState> {
    return ipcRenderer.invoke(IpcChannel.GetDormantState);
  },
  realtime: {
    mintToken(req?: RealtimeSessionRequest): Promise<RealtimeEphemeralToken> {
      return ipcRenderer.invoke(IpcChannel.RealtimeMintToken, req);
    },
  },
  tool: {
    call(req: ToolCallRequest): Promise<ToolCallResponse> {
      return ipcRenderer.invoke(IpcChannel.ToolCall, req);
    },
    onCall(cb) {
      const listener = (_evt: unknown, req: ToolCallRequest): void => cb(req);
      ipcRenderer.on(IpcChannel.ToolCall, listener);
      return () => ipcRenderer.removeListener(IpcChannel.ToolCall, listener);
    },
    onResult(cb) {
      const listener = (_evt: unknown, payload: ToolResultPayload): void => cb(payload);
      ipcRenderer.on(IpcChannel.ToolResult, listener);
      return () => ipcRenderer.removeListener(IpcChannel.ToolResult, listener);
    },
  },
  mic: {
    setStatus(payload: MicStatusPayload): void {
      ipcRenderer.send(IpcChannel.MicStatus, payload);
    },
    onStatus(cb) {
      const listener = (_evt: unknown, payload: MicStatusPayload): void => cb(payload);
      ipcRenderer.on(IpcChannel.MicStatus, listener);
      return () => ipcRenderer.removeListener(IpcChannel.MicStatus, listener);
    },
  },
  window: {
    resizeStrip(dims: StripResizeRequest): Promise<StripResizeResponse> {
      return ipcRenderer.invoke(IpcChannel.WindowStripResize, dims);
    },
  },
  state: {
    onPatch(cb) {
      const listener = (_evt: unknown, payload: StatePatchPayload): void => cb(payload);
      ipcRenderer.on(IpcChannel.StatePatch, listener);
      return () => ipcRenderer.removeListener(IpcChannel.StatePatch, listener);
    },
  },
  ask: {
    onShow(cb) {
      const listener = (_evt: unknown, payload: AskShowPayload): void => cb(payload);
      ipcRenderer.on(IpcChannel.AskShow, listener);
      return () => ipcRenderer.removeListener(IpcChannel.AskShow, listener);
    },
    answer(payload: AskAnswerPayload): void {
      ipcRenderer.send(IpcChannel.AskAnswer, payload);
    },
  },
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('director', api);
  } catch (err) {
    console.error('[director:preload] failed to expose bridge', err);
  }
} else {
  // Non-isolated fallback for dev (contextIsolation: false).
  (window as unknown as { director: DirectorBridge }).director = api;
}
