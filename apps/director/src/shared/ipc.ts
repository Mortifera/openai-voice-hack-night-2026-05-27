/**
 * IPC channel names and payload types shared between main and renderer.
 *
 * Keep this surface minimal — the architecture agent will design the full
 * state-machine / IPC pattern. For boilerplate we only need:
 *   - hotkey notification (main → renderer)
 *   - dormant state query (renderer → main)
 *   - summon request (renderer → main)
 *   - realtime ephemeral token mint (renderer → main → OpenAI)
 */

import type { RealtimeEphemeralToken, RealtimeSessionRequest } from './realtime.js';

export const IpcChannel = {
  HotkeyPressed: 'director:hotkey-pressed',
  GetDormantState: 'director:get-dormant-state',
  RequestSummon: 'director:request-summon',
  RealtimeMintToken: 'director:realtime-mint-token',
} as const;

export type IpcChannel = (typeof IpcChannel)[keyof typeof IpcChannel];

export interface DormantState {
  dormant: boolean;
}

export type HotkeyListener = () => void;

/**
 * Shape exposed on `window.director` via contextBridge.
 */
export interface DirectorBridge {
  onHotkey: (cb: HotkeyListener) => () => void;
  requestSummon: () => Promise<void>;
  getDormantState: () => Promise<DormantState>;
  realtime: {
    mintToken: (req?: RealtimeSessionRequest) => Promise<RealtimeEphemeralToken>;
  };
}

declare global {
  interface Window {
    director: DirectorBridge;
  }
}
