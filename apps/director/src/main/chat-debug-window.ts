/**
 * Chat debug window — a second, normal BrowserWindow used to surface the
 * conversation history / transcript / dev controls while the primary Strip
 * overlay stays slim on the right edge of the screen.
 *
 * Opened on demand from the tray menu. The renderer is the same one the
 * Strip loads, but with a `?surface=chat` query param so it can pick a
 * different layout (chat UI instead of strip glyphs).
 */

import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { is } from '@electron-toolkit/utils';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const CHAT_WIDTH = 480;
const CHAT_HEIGHT = 720;

let chatWindow: BrowserWindow | null = null;

export function showChatDebugWindow(): BrowserWindow {
  if (chatWindow && !chatWindow.isDestroyed()) {
    if (!chatWindow.isVisible()) chatWindow.show();
    chatWindow.focus();
    return chatWindow;
  }

  const display = screen.getPrimaryDisplay();
  const { workArea } = display;
  const x = workArea.x + Math.round((workArea.width - CHAT_WIDTH) / 2);
  const y = workArea.y + Math.round((workArea.height - CHAT_HEIGHT) / 2);

  chatWindow = new BrowserWindow({
    width: CHAT_WIDTH,
    height: CHAT_HEIGHT,
    x,
    y,
    show: false,
    frame: true,
    resizable: true,
    movable: true,
    closable: true,
    title: 'Director — Chat (debug)',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  chatWindow.on('ready-to-show', () => {
    chatWindow?.show();
    chatWindow?.focus();
  });
  chatWindow.on('closed', () => {
    chatWindow = null;
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    chatWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/?surface=chat`);
  } else {
    chatWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { surface: 'chat' },
    });
  }

  return chatWindow;
}

export function getChatDebugWindow(): BrowserWindow | null {
  return chatWindow && !chatWindow.isDestroyed() ? chatWindow : null;
}
