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
  type RealtimeReconnectStatePayload,
  type RealtimeRotationRequestPayload,
  type RealtimeRotationResponse,
  type SessionResumeAvailablePayload,
  type StateSnapshotPushPayload,
  type StripCanvasRenderPayload,
  type CanvasUserResponseRelayPayload,
  type AppOnboardingCompletePayload,
  type AppOnboardingCompleteResponse,
  type AppNotifyDegradedPayload,
  type WindowSetStripMovablePayload,
  type RealtimeMintErrorPayload,
  type SessionResumePayload,
  type SessionResumeResponse,
} from '../shared/ipc.js';
import type { CodexEvent } from '../shared/codex.js';
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
  // ─── § codex-event-bridge (W3 — P4) ────────────────────────────────────
  codex: {
    onEvent(cb) {
      const listener = (_evt: unknown, event: CodexEvent): void => cb(event);
      ipcRenderer.on(IpcChannel.CodexEvent, listener);
      return () => ipcRenderer.removeListener(IpcChannel.CodexEvent, listener);
    },
  },
  // ─── § realtime-rotation + reconnect (W2 — P6.1 + P6.2) ────────────────
  realtimeRotation: {
    requestRotation(
      payload: RealtimeRotationRequestPayload,
    ): Promise<RealtimeRotationResponse> {
      return ipcRenderer.invoke(IpcChannel.RealtimeRotationRequest, payload);
    },
    reportReconnectState(payload: RealtimeReconnectStatePayload): void {
      try {
        ipcRenderer.send(IpcChannel.RealtimeReconnectState, payload);
      } catch (err) {
        // Best-effort: never let a degraded-state report crash the client.
        console.warn('[preload] realtimeRotation.reportReconnectState failed', err);
      }
    },
  },
  // ─── § session-resume (W3 — P6.3b) ─────────────────────────────────────
  session: {
    onResumeAvailable(cb) {
      const listener = (
        _evt: unknown,
        payload: SessionResumeAvailablePayload,
      ): void => cb(payload);
      ipcRenderer.on(IpcChannel.SessionResumeAvailable, listener);
      return () =>
        ipcRenderer.removeListener(
          IpcChannel.SessionResumeAvailable,
          listener,
        );
    },
    // ─── § renderer-wireup (gap 6) ──────────────────────────────────────
    resume(payload: SessionResumePayload): Promise<SessionResumeResponse> {
      return ipcRenderer.invoke(IpcChannel.SessionResume, payload);
    },
  },
  // ─── § persistence-wiring (gap 5) ──────────────────────────────────────
  persistence: {
    pushSnapshot(payload: StateSnapshotPushPayload): void {
      try {
        ipcRenderer.send(IpcChannel.StateSnapshotPush, payload);
      } catch (err) {
        // Best-effort: a failed persist push must never crash the renderer.
        console.warn('[preload] persistence.pushSnapshot failed', err);
      }
    },
  },
  // ─── § renderer-wireup (gaps 1/2/6/8/9/10/11) ──────────────────────────
  canvas: {
    render(payload: StripCanvasRenderPayload): void {
      try {
        ipcRenderer.send(IpcChannel.StripCanvasRender, payload);
      } catch (err) {
        console.warn('[preload] canvas.render relay failed', err);
      }
    },
    onUserResponse(cb) {
      const listener = (
        _evt: unknown,
        payload: CanvasUserResponseRelayPayload,
      ): void => cb(payload);
      ipcRenderer.on(IpcChannel.CanvasUserResponseRelay, listener);
      return () =>
        ipcRenderer.removeListener(
          IpcChannel.CanvasUserResponseRelay,
          listener,
        );
    },
  },
  app: {
    onboardingComplete(
      payload: AppOnboardingCompletePayload,
    ): Promise<AppOnboardingCompleteResponse> {
      return ipcRenderer.invoke(IpcChannel.AppOnboardingComplete, payload);
    },
    notifyDegraded(payload: AppNotifyDegradedPayload): void {
      try {
        ipcRenderer.send(IpcChannel.AppNotifyDegraded, payload);
      } catch (err) {
        console.warn('[preload] app.notifyDegraded failed', err);
      }
    },
  },
  windowControl: {
    setStripMovable(payload: WindowSetStripMovablePayload): void {
      try {
        ipcRenderer.send(IpcChannel.WindowSetStripMovable, payload);
      } catch (err) {
        console.warn('[preload] windowControl.setStripMovable failed', err);
      }
    },
  },
  realtimeErrors: {
    onMintError(cb) {
      const listener = (
        _evt: unknown,
        payload: RealtimeMintErrorPayload,
      ): void => cb(payload);
      ipcRenderer.on(IpcChannel.RealtimeMintError, listener);
      return () =>
        ipcRenderer.removeListener(IpcChannel.RealtimeMintError, listener);
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
