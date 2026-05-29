import { app, BrowserWindow, globalShortcut, ipcMain, Menu, Notification, screen, Tray, nativeImage } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { config as loadDotenv } from 'dotenv';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IpcChannel,
  type DormantState,
  type ToolCallRequest,
  type ToolCallResponse,
  type MicStatusPayload,
  type RealtimeReconnectStatePayload,
  type RealtimeRotationRequestPayload,
  type RealtimeRotationResponse,
  type StripResizeRequest,
  type StripResizeResponse,
} from '../shared/ipc.js';
import type { RealtimeEphemeralToken, RealtimeSessionRequest } from '../shared/realtime.js';
import { mintEphemeralToken, prepareRotation } from './realtime.js';
import { randomUUID } from 'node:crypto';
import {
  createCanvasWindow,
  dismissCanvas,
  registerCanvasIpc,
  renderCanvas,
  getCanvasWindow,
  setStripWindow,
} from './canvas.js';
import { registerToolRouterIpc } from './tool-router.js';
import { showChatDebugWindow } from './chat-debug-window.js';
import { registerPlannerDevIpc, setCompactionClient } from './planner.js';
import { registerCodexPoolIpc, abortAllAgents } from './codex-pool.js';
// ─── § push-to-talk (native global key listener — uiohook-napi) ──────────
import { startPttListener, stopPttListener } from './ptt-listener.js';
import OpenAI from 'openai';
// ─── § canvas-degradation (W5 — P6.6) ───────────────────────────────────
import { writeEnvKey } from './env-writer.js';
import type {
  AppWriteEnvRequest,
  AppWriteEnvResponse,
} from '../shared/ipc.js';
// ─── § session-resume (W3 — P6.3b) ──────────────────────────────────────
import {
  findResumableSession,
  forceFlushSnapshot,
  registerSideStoreIpc,
} from './side-store.js';
import type { SessionResumeAvailablePayload } from '../shared/ipc.js';
// ─── § persistence-wiring (gap 5) ───────────────────────────────────────
import {
  registerSnapshotPushIpc,
  writeSessionInitMeta,
} from './side-store.js';
// ─── § renderer-wireup (gap 6) — resume hydration ───────────────────────
import { hydrateExistingSession, getSessionId } from './side-store.js';
import type {
  SessionResumePayload,
  SessionResumeResponse,
} from '../shared/ipc.js';
// ─── § renderer-wireup (gaps 2/6/9/10/11) ───────────────────────────────
import {
  CanvasIpcChannel,
  type CanvasUserResponsePayload,
} from '../shared/canvas-ipc.js';
import type {
  StripCanvasRenderPayload,
  CanvasUserResponseRelayPayload,
  WindowSetStripMovablePayload,
  AppNotifyDegradedPayload,
} from '../shared/ipc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ───────────────────────────────────────────────────────────────────────────
// .env loading. Order: repo-root .env (wins) → apps/director/.env (fallback).
// dotenv does not overwrite existing keys by default, so loading repo-root
// FIRST gives it precedence. OPENAI_API_KEY must never reach the renderer —
// the main process mints short-lived Realtime tokens instead.
// ───────────────────────────────────────────────────────────────────────────
const APP_DIR = resolve(__dirname, '..', '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
loadDotenv({ path: resolve(REPO_ROOT, '.env') });
loadDotenv({ path: resolve(APP_DIR, '.env') });

// ───────────────────────────────────────────────────────────────────────────
// Director Strip overlay geometry — slim right-edge pill that grows per
// state via the `strip.resize` IPC (state-driven Hive/listening sizes).
// ───────────────────────────────────────────────────────────────────────────
const STRIP_WIDTH = 12;
const STRIP_HEIGHT = 180;
const STRIP_EDGE_OFFSET = 20;
const STRIP_MAX_WIDTH = 320;
const STRIP_MAX_HEIGHT = 480;

let stripWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quittingExplicitly = false;

function computeStripBounds(): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const x = workArea.x + workArea.width - STRIP_WIDTH - STRIP_EDGE_OFFSET;
  const y = workArea.y + Math.round((workArea.height - STRIP_HEIGHT) / 2);
  return { x, y, width: STRIP_WIDTH, height: STRIP_HEIGHT };
}

function createStripWindow(): BrowserWindow {
  const bounds = computeStripBounds();

  const window = new BrowserWindow({
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
      preload: join(__dirname, '../preload/index.mjs'),
      // sandbox:false is required because the preload is an ESM (.mjs) file —
      // sandbox:true + non-.cjs preload silently breaks contextBridge.
      // See docs/contracts.md § 9.2.
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Float above fullscreen apps and follow the user across spaces.
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  window.on('ready-to-show', () => {
    window.show();
  });

  // Don't allow close to quit; hide instead. Quit only via tray.
  window.on('close', (event) => {
    if (!quittingExplicitly) {
      event.preventDefault();
      window.hide();
    }
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => {
        if (!stripWindow) return;
        if (stripWindow.isVisible()) {
          stripWindow.hide();
        } else {
          stripWindow.show();
        }
      },
    },
    {
      label: 'Show Chat (debug)',
      click: () => {
        showChatDebugWindow();
      },
    },
    {
      label: 'Preferences…',
      enabled: false, // stub
    },
    { type: 'separator' },
    {
      label: 'Quit Director',
      accelerator: 'Command+Q',
      click: () => {
        quittingExplicitly = true;
        app.quit();
      },
    },
  ]);
}

function createTray(): void {
  // Tiny monochrome placeholder. We use a 1x1 transparent template image —
  // macOS will render the system "•" name fallback if no icon present.
  // For now, build a minimal template image at runtime.
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setTitle('●'); // monochrome bullet — placeholder Strip glyph
  tray.setToolTip('Director');
  tray.setContextMenu(buildTrayMenu());
}

// ─── § renderer-wireup (gap 2) — tray degraded indicator ─────────────────
// Flip the tray glyph red-dot while the realtime client is persistently
// degraded (after the reconnect FSM exhausts its retries). Restores the
// neutral bullet on recovery. No-op if the tray hasn't been created yet.
function setTrayDegraded(degraded: boolean): void {
  if (!tray || tray.isDestroyed()) return;
  try {
    tray.setTitle(degraded ? '🔴' : '●');
    tray.setToolTip(degraded ? 'Director — offline, reconnecting…' : 'Director');
  } catch (err) {
    console.warn('[director] setTrayDegraded failed', err);
  }
}

function registerGlobalHotkey(): void {
  const accelerator = 'CommandOrControl+Shift+Space';
  const ok = globalShortcut.register(accelerator, () => {
    console.log('[director] hotkey pressed');
    stripWindow?.webContents.send(IpcChannel.HotkeyPressed);
  });
  if (!ok) {
    console.warn(`[director] failed to register hotkey ${accelerator}`);
  }

  // ─── Dev keystrokes — manual Canvas QA without the Realtime layer. ────
  // Hyper chord (Ctrl+Alt+Cmd) — nothing else uses it.
  //   ⌃⌥⌘M → toggle Mixtape moodboard
  //   ⌃⌥⌘A → toggle Mixtape artifact reveal
  //   ⌃⌥⌘H → toggle Harness rule-save flash
  //   ⌃⌥⌘X → dismiss Canvas
  if (is.dev) {
    registerDevCanvasShortcuts();
  }
}

function registerDevCanvasShortcuts(): void {
  const matteVinyl = `file://${resolve(APP_DIR, 'src/renderer/src/assets/matte-vinyl.png')}`;
  const cassette = `file://${resolve(APP_DIR, 'src/renderer/src/assets/cassette.png')}`;
  const holographic = `file://${resolve(APP_DIR, 'src/renderer/src/assets/holographic.png')}`;
  const tokyoNeon = `file://${resolve(APP_DIR, 'src/renderer/src/assets/tokyo-neon.png')}`;

  const toggleMoodboard = (): void => {
    if (getCanvasWindow()?.isVisible()) {
      dismissCanvas();
      return;
    }
    renderCanvas({
      component_id: `dev-moodboard-${randomUUID()}`,
      component: 'moodboard',
      props: {
        title: 'Card material',
        concepts: [
          {
            id: 'matte-vinyl',
            label: 'Matte Vinyl',
            description: 'Premium, monochrome, calm',
            image_url: matteVinyl,
          },
          {
            id: 'cassette',
            label: 'Cassette',
            description: 'Translucent amber, warm 80s',
            image_url: cassette,
          },
          {
            id: 'holographic',
            label: 'Holographic',
            description: 'Iridescent foil, playful',
            image_url: holographic,
          },
        ],
      },
    });
  };

  const toggleArtifact = (): void => {
    if (getCanvasWindow()?.isVisible()) {
      dismissCanvas();
      return;
    }
    renderCanvas({
      component_id: `dev-artifact-${randomUUID()}`,
      component: 'artifact_preview',
      props: {
        title: 'Mixtape',
        notes: 'Tokyo Neon · 6 tracks',
        mixtape: {
          vibe: 'late-night drive through Tokyo neon',
          coverUrl: tokyoNeon,
          tracks: [
            { title: 'Midnight Driver', artist: 'Akira Vance', runtime: '4:12' },
            { title: 'Velvet Apartment', artist: 'Noémie Hara', runtime: '3:48' },
            { title: 'Neon Rain', artist: 'Sable Sound', runtime: '5:02' },
            { title: 'Hyperreal', artist: 'Yoko & The Visa', runtime: '4:31' },
            { title: 'Lights From The Tower', artist: 'CHROMERIDER', runtime: '3:55' },
            { title: 'Akihabara Sunrise', artist: 'Aoi Tanaka', runtime: '4:24' },
          ],
        },
        actions: ['ship', 'iterate', 'discard'],
      },
    });
  };

  const toggleRule = (): void => {
    if (getCanvasWindow()?.isVisible()) {
      dismissCanvas();
      return;
    }
    renderCanvas({
      component_id: `dev-rule-${randomUUID()}`,
      component: 'harness_rule_save',
      props: {
        rule: 'No gradients ever.',
        why: 'Said live, T+0:42.',
      },
      autoDismissMs: 1200,
    });
  };

  // Hyper chord (Ctrl+Alt+Cmd+key) — nothing on macOS binds this by default.
  const okM = globalShortcut.register('Control+Alt+Cmd+M', toggleMoodboard);
  const okA = globalShortcut.register('Control+Alt+Cmd+A', toggleArtifact);
  const okH = globalShortcut.register('Control+Alt+Cmd+H', toggleRule);
  const okX = globalShortcut.register('Control+Alt+Cmd+X', () => dismissCanvas());
  console.log(`[hotkeys] M=${okM} A=${okA} H=${okH} X=${okX}`);
}

function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.GetDormantState, async (): Promise<DormantState> => {
    return { dormant: true };
  });

  ipcMain.handle(IpcChannel.RequestSummon, async (): Promise<void> => {
    console.log('[director] summon requested (stub)');
  });

  ipcMain.handle(
    IpcChannel.RealtimeMintToken,
    async (evt, req: RealtimeSessionRequest = {}): Promise<RealtimeEphemeralToken> => {
      try {
        const token = await mintEphemeralToken(req);
        console.log(
          `[director] minted realtime token model=${token.model} expires_at=${token.expiresAt}`,
        );
        return token;
      } catch (err) {
        // ─── § renderer-wireup (gap 11) ─────────────────────────────────
        // Surface auth / mint failures back to the strip renderer so it can
        // open the api_key_missing card. We parse the HTTP status out of the
        // mint error message ("HTTP 401 — …") and special-case 401 + the
        // "OPENAI_API_KEY is not set" guard as auth (status 401).
        const message = err instanceof Error ? err.message : String(err);
        const httpMatch = /HTTP (\d{3})/.exec(message);
        const missingKey = message.includes('OPENAI_API_KEY is not set');
        const status = missingKey ? 401 : httpMatch ? Number(httpMatch[1]) : 0;
        try {
          evt.sender.send(IpcChannel.RealtimeMintError, { status, message });
        } catch (sendErr) {
          console.warn('[director] realtime.mintError send failed', sendErr);
        }
        throw err;
      }
    },
  );

  // ─── tool.call ───────────────────────────────────────────────────────
  // The W3 tool-router owns the canonical handler — it dispatches to one
  // of four tool implementations (render_canvas / dispatch_agent_mock /
  // ask_user / update_harness) and pushes the resulting state mutations
  // into the strip renderer via `state.patch`. `registerToolRouterIpc`
  // is called from app.whenReady once the strip window exists.

  // ─── mic.status (W1.hotkey) ──────────────────────────────────────────
  // Renderer with the peer publishes mic state; rebroadcast so every
  // window (Strip listening view, Canvas) can reflect it.
  ipcMain.on(IpcChannel.MicStatus, (evt, payload: MicStatusPayload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.id === evt.sender.id) continue;
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(IpcChannel.MicStatus, payload);
      } catch (err) {
        console.warn('[director] mic.status broadcast failed', err);
      }
    }
  });

  // ─── window.strip.resize (W2) ────────────────────────────────────────
  // The renderer requests Strip size changes per stripState (listening
  // expands, Hive grows further). Re-anchor to the right edge on every
  // resize so the strip "grows leftward" instead of drifting off-screen.
  ipcMain.handle(
    IpcChannel.WindowStripResize,
    async (_evt, dims: StripResizeRequest): Promise<StripResizeResponse> => {
      if (!stripWindow || stripWindow.isDestroyed()) {
        return { ok: false, error: 'no strip window' };
      }
      const display = screen.getPrimaryDisplay();
      const { workArea } = display;
      const width = Math.min(Math.max(dims.width, STRIP_WIDTH), STRIP_MAX_WIDTH);
      const height = Math.min(Math.max(dims.height, STRIP_HEIGHT), STRIP_MAX_HEIGHT);
      const x = workArea.x + workArea.width - width - STRIP_EDGE_OFFSET;
      const currentY = stripWindow.getBounds().y;
      stripWindow.setBounds({ x, y: currentY, width, height }, true);
      return { ok: true };
    },
  );

  // ─── § realtime-rotation + reconnect (W2 — P6.1 + P6.2) ──────────────
  // The lifecycle FSM in the renderer requests rotation @ T+55. Main
  // mints Session_B + materializes a World State Brief from the side
  // store; the renderer opens a 2nd peer, injects the Brief, and swaps
  // audio at the next VAD-silent window. See remaining-phases.md §6.1.
  ipcMain.handle(
    IpcChannel.RealtimeRotationRequest,
    async (
      _evt,
      payload: RealtimeRotationRequestPayload,
    ): Promise<RealtimeRotationResponse> => {
      const requestId = payload?.requestId ?? 'rot-unknown';
      // ─── § persistence-wiring (gap 5) ─────────────────────────────────
      // Advisory 13: drain the debounced snapshot writer at session
      // rotation so Session_B's World State Brief reseeds from on-disk
      // state that's current as of the rotation request — not ≤1.5s stale.
      // Fire-and-forget; rotation prep below does not depend on the flush.
      void forceFlushSnapshot().catch((err) =>
        console.warn('[director] forceFlushSnapshot during rotation failed', err),
      );
      try {
        const { token, brief } = await prepareRotation({ voice: payload?.voice });
        // session_id is opaque on the OpenAI mint response — the renderer
        // assigns its own correlation id once the new peer is up. We pass
        // the request id back so caller can match the response.
        return {
          ok: true,
          requestId,
          newToken: token.value,
          newSessionId: requestId,
          expiresAt: token.expiresAt,
          brief,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[director] rotation request failed', message);
        return { ok: false, requestId, error: message };
      }
    },
  );

  // Renderer reports degraded → retrying → live transitions for tray /
  // notifications. Fire-and-forget — never block the renderer.
  ipcMain.on(
    IpcChannel.RealtimeReconnectState,
    (_evt, payload: RealtimeReconnectStatePayload) => {
      if (!payload || typeof payload !== 'object') {
        console.warn('[director] reconnect state event with bad payload', payload);
        return;
      }
      console.log(
        `[director] reconnect state=${payload.state} attempt=${payload.attempt} outageMs=${payload.outageMs}`,
      );
      // ─── § renderer-wireup (gap 2) ─────────────────────────────────────
      // Flip the tray red dot while degraded / persistently-offline; clear
      // it once the FSM reports 'live'. The macOS notification is handled
      // separately via `app.notifyDegraded` so it fires exactly once.
      setTrayDegraded(
        payload.state === 'degraded' ||
          payload.state === 'retrying' ||
          payload.state === 'offline-persistent',
      );
    },
  );

  // ─── § canvas-degradation (W5 — P6.6) ────────────────────────────────
  // ApiKeyMissing canvas card → main process: persist the user-typed
  // OPENAI_API_KEY to the repo-root .env via atomic tmp+rename. The
  // handler is allow-listed at the env-writer layer; payload validation
  // tolerates wrong types with `console.warn` + a `{ ok: false }` reply.
  ipcMain.handle(
    IpcChannel.AppWriteEnv,
    async (
      _evt,
      payload: AppWriteEnvRequest,
    ): Promise<AppWriteEnvResponse> => {
      try {
        const result = await writeEnvKey(payload);
        if (!result.ok) {
          console.warn(`[director] app.writeEnv rejected: ${result.error}`);
        } else {
          console.log(
            `[director] app.writeEnv wrote key=${payload?.key ?? 'unknown'} to ${result.path}`,
          );
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[director] app.writeEnv threw', message);
        return { ok: false, error: message };
      }
    },
  );

  // ─── § renderer-wireup (gaps 2/6/9/10/11) ────────────────────────────
  // The strip renderer can't reach the Canvas BrowserWindow directly — its
  // `commands.openCanvas` only mutates the strip's local store. These
  // handlers bridge the gap so the strip can (a) drive the Canvas window
  // for degradation cards + the resume picker, (b) learn when the user
  // interacts with a Canvas card, (c) toggle the Strip window movable while
  // the Canvas is open, and (d) surface the persistent-degraded notification.

  // (a) strip.canvas.render → forward to the Canvas window.
  ipcMain.on(
    IpcChannel.StripCanvasRender,
    (_evt, payload: StripCanvasRenderPayload) => {
      if (!payload || typeof payload.component !== 'string') {
        console.warn('[director] strip.canvas.render bad payload', payload);
        return;
      }
      try {
        renderCanvas({
          component: payload.component,
          props: payload.props ?? {},
          component_id: payload.component_id,
          call_id: payload.call_id,
          autoDismissMs: payload.autoDismissMs,
        });
      } catch (err) {
        console.warn('[director] strip.canvas.render failed', err);
      }
    },
  );

  // (b) canvas.user_response → relay to the strip window so the resume
  // picker + onboarding can resolve. The Canvas window sends this; main's
  // canvas.ts + tool-router already log it. ipcMain.on supports multiple
  // listeners, so this relay coexists with those.
  ipcMain.on(
    CanvasIpcChannel.UserResponse,
    (_evt, payload: CanvasUserResponsePayload) => {
      if (!payload || typeof payload.component_id !== 'string') return;
      const relay: CanvasUserResponseRelayPayload = {
        component_id: payload.component_id,
        value: payload.value,
        call_id: payload.call_id,
      };
      const target = stripWindow;
      if (!target || target.isDestroyed()) return;
      try {
        target.webContents.send(IpcChannel.CanvasUserResponseRelay, relay);
      } catch (err) {
        console.warn('[director] canvas.user_response relay failed', err);
      }
    },
  );

  // (c) window.setStripMovable → toggle the Strip window movable flag.
  ipcMain.on(
    IpcChannel.WindowSetStripMovable,
    (_evt, payload: WindowSetStripMovablePayload) => {
      if (!stripWindow || stripWindow.isDestroyed()) return;
      try {
        stripWindow.setMovable(payload?.movable === true);
      } catch (err) {
        console.warn('[director] window.setStripMovable failed', err);
      }
    },
  );

  // (d) app.notifyDegraded → single macOS notification (fired once by the
  // renderer FSM at persistent-degraded) + ensure the tray dot is red.
  ipcMain.on(
    IpcChannel.AppNotifyDegraded,
    (_evt, payload: AppNotifyDegradedPayload) => {
      setTrayDegraded(true);
      try {
        if (Notification.isSupported()) {
          const seconds = Math.round((payload?.outageMs ?? 0) / 1000);
          new Notification({
            title: 'Director offline',
            body:
              seconds > 0
                ? `Reconnecting… (offline ${seconds}s). Use the chat fallback if needed.`
                : 'Reconnecting… Use the chat fallback if needed.',
            silent: false,
          }).show();
        }
      } catch (err) {
        console.warn('[director] app.notifyDegraded notification failed', err);
      }
    },
  );

  // ─── § renderer-wireup (gap 6) — resume picker resolution ────────────
  // The strip renderer's resume-picker subscriber calls this when the user
  // picks Resume / Start fresh. Resume re-points the side store at the prior
  // session dir (planner reads instructions from disk every consult, so the
  // pointer swap IS the hydration); Start fresh keeps the boot-minted dir.
  ipcMain.handle(
    IpcChannel.SessionResume,
    async (_evt, payload: SessionResumePayload): Promise<SessionResumeResponse> => {
      try {
        if (payload?.choice === 'resume' && payload.sessionId) {
          const { goal } = await hydrateExistingSession(payload.sessionId);
          console.log(
            `[director] session.resume → hydrated id=${payload.sessionId} goal=${goal ?? '(none)'}`,
          );
          return { ok: true, choice: 'resume', sessionId: payload.sessionId, goal };
        }
        // Start fresh — the boot-minted session is already active. Just ack.
        const fresh = getSessionId();
        console.log(`[director] session.resume → start fresh id=${fresh ?? '(pending)'}`);
        return { ok: true, choice: 'fresh', sessionId: fresh, goal: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[director] session.resume failed', message);
        return { ok: false, error: message };
      }
    },
  );
}

// ───────────────────────────────────────────────────────────────────────────
// App lifecycle
// ───────────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  electronApp.setAppUserModelId('ai.director');

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // Overlay app — hide from dock on macOS so it lives only in the tray.
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  stripWindow = createStripWindow();
  // Canvas positions itself relative to the Strip — hand over the ref
  // before pre-creating the Canvas window.
  setStripWindow(stripWindow);

  // Re-anchor Strip when monitors/resolutions change so it stays pinned
  // to the right edge of the (possibly new) primary display.
  const reanchorStrip = (): void => {
    if (!stripWindow || stripWindow.isDestroyed()) return;
    const bounds = stripWindow.getBounds();
    const display = screen.getPrimaryDisplay();
    const { workArea } = display;
    const x = workArea.x + workArea.width - bounds.width - STRIP_EDGE_OFFSET;
    const y = workArea.y + Math.round((workArea.height - bounds.height) / 2);
    stripWindow.setBounds({ x, y, width: bounds.width, height: bounds.height });
  };
  screen.on('display-metrics-changed', reanchorStrip);
  screen.on('display-added', reanchorStrip);
  screen.on('display-removed', reanchorStrip);
  // Pre-create the Canvas window hidden so first open is instant.
  createCanvasWindow();
  registerCanvasIpc();
  createTray();
  registerGlobalHotkey();
  registerIpcHandlers();
  registerToolRouterIpc(stripWindow);
  registerPlannerDevIpc(stripWindow);
  registerCodexPoolIpc(stripWindow);

  // ─── § push-to-talk (native global key listener) ────────────────────
  // Hold ⌃⌥ to talk, double-tap to lock hands-free. Drives connect-on-
  // demand + mic open/close in the strip renderer. Gracefully no-ops if
  // the native listener can't start (e.g. Input Monitoring not granted).
  startPttListener(stripWindow);

  // ─── § side-store bootstrap (W3 — gap 7) ────────────────────────────
  // Boot the on-disk session dir + register the snapshot IPC. Async +
  // idempotent (calls initSession internally); fire-and-forget so it
  // doesn't block window creation. Without this, planner / rotation
  // reads of the side store would lazily init a *different* session than
  // the resume scanner expects, and the renderer's `sidestore.snapshot`
  // round-trip would have no handler.
  void registerSideStoreIpc().catch((err) =>
    console.warn('[director] registerSideStoreIpc failed', err),
  );

  // ─── § persistence-wiring (gap 5) ───────────────────────────────────
  // Wire the renderer's `state.snapshotPush` channel → side-store's
  // `writeStateSnapshot` (debounced) + `writeMeta` (on goal change). Main
  // keeps no full state mirror, so the canonical renderer store is the
  // push source. Also write the `meta.json` header once at boot with the
  // app version + project path so the resume scanner has a header before
  // the first goal is set. `writeSessionInitMeta` runs AFTER the session
  // dir exists (chained off registerSideStoreIpc → initSession).
  registerSnapshotPushIpc();
  void registerSideStoreIpc()
    .then(() => writeSessionInitMeta({ appVersion: app.getVersion() }))
    .catch((err) =>
      console.warn('[director] writeSessionInitMeta failed', err),
    );

  // ─── § compaction-client bootstrap (W1 — gap 3) ─────────────────────
  // Hand the planner a real OpenAI client so `fireCompactionAsync` stops
  // early-returning (no client ⇒ it falls back to the server-side
  // `context_management` net only). Same OPENAI_API_KEY the planner /
  // realtime mint paths read from process.env. If the key is missing we
  // skip wiring — the planner still runs consults via its own fetch path
  // and compaction degrades gracefully to the server-side safety net.
  if (process.env.OPENAI_API_KEY) {
    setCompactionClient(new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));
  } else {
    console.warn(
      '[director] OPENAI_API_KEY missing — manual compaction disabled (server-side context_management still active)',
    );
  }

  // ─── § session-resume (W3 — P6.3b) ──────────────────────────────────
  // Scan the on-disk sessions dir for a <7d-old session. If found,
  // forward a small preview to the strip renderer once it's ready —
  // ipcSync turns that into a transcript utterance + options_picker
  // Canvas. The snapshot itself is NOT applied at this stage; the
  // renderer stages the prompt and the user picks "Resume" / "Start
  // fresh". The actual hydration call is deferred until the picker
  // resolves (post-R3 follow-up).
  void announceResumableSession();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      stripWindow = createStripWindow();
    } else {
      stripWindow?.show();
    }
  });
});

// Overlay app: do NOT quit when all windows close. Quit only via tray "Quit".
// We intentionally never call app.quit() here — the tray Quit item handles it.
app.on('window-all-closed', () => {
  // no-op
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopPttListener(); // § push-to-talk — release the native global listener
});

app.on('before-quit', () => {
  quittingExplicitly = true;
  // Best-effort: tear down any in-flight Codex subprocesses + worktrees so
  // the next launch starts from a clean slate. Fire-and-forget.
  void abortAllAgents().catch((err) =>
    console.warn('[director] abortAllAgents during before-quit failed', err),
  );
  // ─── § session-resume (W3 — P6.3b) ──────────────────────────────────
  // Drain the debounced state.snapshot.json + meta.json writers so the
  // next launch sees state ≤1.5s before the kill. Fire-and-forget — the
  // before-quit event is synchronous, but flushSnapshotNow uses an
  // atomic tmp+rename which is fast enough that the process typically
  // exits cleanly after this promise resolves. SIGKILL still beats us,
  // by definition; this covers all polite quit paths.
  void forceFlushSnapshot().catch((err) =>
    console.warn('[director] forceFlushSnapshot during before-quit failed', err),
  );
});

// ─── § session-resume (W3 — P6.3b) ──────────────────────────────────────
// Append-only helper. Lives below the main lifecycle handlers so its
// dependencies (stripWindow) are guaranteed to be defined. Looks up the
// most recent on-disk session via the side-store scanner; if found, waits
// for the strip renderer to be ready and posts the preview over the
// `session.resumeAvailable` channel.
async function announceResumableSession(): Promise<void> {
  let preview;
  try {
    preview = await findResumableSession();
  } catch (err) {
    console.warn('[director] findResumableSession failed', err);
    return;
  }
  if (!preview) return;
  const payload: SessionResumeAvailablePayload = {
    resumeAvailable: true,
    sessionPreview: {
      sessionId: preview.sessionId,
      projectName: preview.projectName,
      currentGoal: preview.currentGoal,
      lastActiveAt: preview.lastActiveAt,
      dir: preview.dir,
    },
  };
  console.log(
    `[director] resumable session found id=${preview.sessionId} goal=${preview.currentGoal ?? '(none)'}`,
  );
  const target = stripWindow;
  if (!target || target.isDestroyed()) return;
  const send = (): void => {
    try {
      target.webContents.send(IpcChannel.SessionResumeAvailable, payload);
    } catch (err) {
      console.warn('[director] session.resumeAvailable send failed', err);
    }
  };
  if (target.webContents.isLoading()) {
    target.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}
