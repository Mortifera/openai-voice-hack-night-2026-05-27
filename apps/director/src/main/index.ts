import { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, nativeImage } from 'electron';
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
  type StripResizeRequest,
  type StripResizeResponse,
} from '../shared/ipc.js';
import type { RealtimeEphemeralToken, RealtimeSessionRequest } from '../shared/realtime.js';
import { mintEphemeralToken } from './realtime.js';
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
// Director chat window geometry.
// ───────────────────────────────────────────────────────────────────────────
const DIRECTOR_WINDOW_WIDTH = 480;
const DIRECTOR_WINDOW_HEIGHT = 720;

let stripWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quittingExplicitly = false;

function computeStripBounds(): { width: number; height: number } {
  return { width: DIRECTOR_WINDOW_WIDTH, height: DIRECTOR_WINDOW_HEIGHT };
}

function createStripWindow(): BrowserWindow {
  const bounds = computeStripBounds();

  const window = new BrowserWindow({
    ...bounds,
    center: true,
    show: false,
    frame: true,
    resizable: true,
    movable: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

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
    async (_evt, req: RealtimeSessionRequest = {}): Promise<RealtimeEphemeralToken> => {
      const token = await mintEphemeralToken(req);
      console.log(
        `[director] minted realtime token model=${token.model} expires_at=${token.expiresAt}`,
      );
      return token;
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
  // Legacy renderer calls still arrive on stripState changes. Director is
  // now a fixed-size chat window, so acknowledge without resizing.
  ipcMain.handle(
    IpcChannel.WindowStripResize,
    async (_evt, _dims: StripResizeRequest): Promise<StripResizeResponse> => {
      return { ok: true };
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
  // Pre-create the Canvas window hidden so first open is instant.
  createCanvasWindow();
  registerCanvasIpc();
  createTray();
  registerGlobalHotkey();
  registerIpcHandlers();
  registerToolRouterIpc(stripWindow);

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
});

app.on('before-quit', () => {
  quittingExplicitly = true;
});
