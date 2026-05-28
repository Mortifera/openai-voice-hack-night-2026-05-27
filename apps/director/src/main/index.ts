import { app, BrowserWindow, globalShortcut, ipcMain, Menu, screen, Tray, nativeImage } from 'electron';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { config as loadDotenv } from 'dotenv';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IpcChannel, type DormantState } from '../shared/ipc.js';
import type { RealtimeEphemeralToken, RealtimeSessionRequest } from '../shared/realtime.js';
import { mintEphemeralToken } from './realtime.js';

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
// Strip geometry (dormant baseline). See docs/ux-design.md Pass 1 & 5.
// ───────────────────────────────────────────────────────────────────────────
const STRIP_WIDTH = 12;
const STRIP_HEIGHT = 180;
const STRIP_EDGE_OFFSET = 20;

let stripWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quittingExplicitly = false;

function computeStripBounds(): { x: number; y: number; width: number; height: number } {
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
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    titleBarStyle: 'hidden',
    type: 'panel',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // True overlay — float above fullscreen apps and screen savers.
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
  createTray();
  registerGlobalHotkey();
  registerIpcHandlers();

  // Recompute strip position if displays change (lid open / monitor unplug).
  screen.on('display-metrics-changed', () => {
    if (!stripWindow) return;
    stripWindow.setBounds(computeStripBounds());
  });
  screen.on('display-added', () => {
    if (!stripWindow) return;
    stripWindow.setBounds(computeStripBounds());
  });
  screen.on('display-removed', () => {
    if (!stripWindow) return;
    stripWindow.setBounds(computeStripBounds());
  });

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
