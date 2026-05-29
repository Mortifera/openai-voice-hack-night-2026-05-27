/**
 * Push-to-talk listener — native global key listener for true hold-to-talk.
 *
 * Electron's `globalShortcut` only fires on key-DOWN — it never sees key-UP —
 * so it can't implement "listen only while held". This module uses
 * `uiohook-napi` (an N-API native module, ABI-stable across Node + Electron)
 * to watch raw global key events and recognize the push-to-talk chord.
 *
 * Gesture model (Wispr Flow-style, see docs):
 *   - HOLD the chord (Control + Option together, nothing else) → talk while
 *     held → release → send. Emits ptt.down / ptt.up.
 *   - DOUBLE-TAP the chord (two quick taps within the double-tap window) →
 *     toggle hands-free lock. Emits ptt.lock.
 *
 * The chord is the two modifiers ⌃⌥ with NO other key pressed — chosen so it
 * never types a character while held in another app, is easy to hold one-
 * handed, and doesn't collide (Ctrl+Option alone isn't a macOS shortcut). A
 * letter / ⌘ / ⇧ joining the chord "contaminates" it and ends the gesture, so
 * Ctrl+Option+<key> shortcuts don't fire push-to-talk.
 *
 * macOS requires Input Monitoring permission (System Settings → Privacy &
 * Security → Input Monitoring) for the global listener to receive events.
 * Without it `uIOhook.start()` succeeds but no events arrive — we log a hint.
 *
 * The pure gesture state machine (`PttGesture`) is split from the native
 * wiring so it can be unit-tested with fake timers (no native module needed).
 */

import type { BrowserWindow } from 'electron';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { IpcChannel } from '../shared/ipc.js';

// ─── Pure gesture state machine ─────────────────────────────────────────

const CTRL_CODES = new Set<number>([UiohookKey.Ctrl, UiohookKey.CtrlRight]);
const ALT_CODES = new Set<number>([UiohookKey.Alt, UiohookKey.AltRight]);
const GESTURE_CODES = new Set<number>([...CTRL_CODES, ...ALT_CODES]);

export interface PttGestureCallbacks {
  /** Chord held past the debounce → start talking (open mic). */
  onDown: () => void;
  /** Chord released after a hold → stop talking (mute mic). */
  onUp: () => void;
  /** Chord double-tapped → toggle hands-free lock. */
  onLock: () => void;
}

export interface PttGestureOpts {
  /** Min ms the chord must stay held to count as a HOLD (vs a tap). */
  holdDebounceMs?: number;
  /** Max ms between two taps to count as a double-tap. */
  doubleTapMs?: number;
}

/**
 * Recognizes hold / tap / double-tap from raw key down/up events. Feed it
 * `keyDown(code)` / `keyUp(code)`; it invokes the callbacks. Uses
 * setTimeout + Date.now so vitest fake timers can drive it deterministically.
 */
export class PttGesture {
  private held = new Set<number>();
  private engaged = false;
  private holdActive = false;
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTapAt = 0;
  private readonly holdDebounceMs: number;
  private readonly doubleTapMs: number;

  constructor(
    private readonly cb: PttGestureCallbacks,
    opts: PttGestureOpts = {},
  ) {
    this.holdDebounceMs = opts.holdDebounceMs ?? 140;
    this.doubleTapMs = opts.doubleTapMs ?? 400;
  }

  keyDown(code: number): void {
    if (this.held.has(code)) return; // ignore auto-repeat
    this.held.add(code);
    this.reevaluate();
  }

  keyUp(code: number): void {
    if (!this.held.delete(code)) return;
    this.reevaluate();
  }

  /** Drop all state (listener stopped / window gone). */
  reset(): void {
    this.held.clear();
    this.clearHoldTimer();
    if (this.holdActive) {
      this.holdActive = false;
      // Don't fire onUp on a forced reset — caller is tearing down.
    }
    this.engaged = false;
    this.lastTapAt = 0;
  }

  private chordEngaged(): boolean {
    if (this.held.size === 0) return false;
    let hasCtrl = false;
    let hasAlt = false;
    for (const code of this.held) {
      if (!GESTURE_CODES.has(code)) return false; // contaminated by another key
      if (CTRL_CODES.has(code)) hasCtrl = true;
      if (ALT_CODES.has(code)) hasAlt = true;
    }
    return hasCtrl && hasAlt;
  }

  private reevaluate(): void {
    const engaged = this.chordEngaged();
    if (engaged && !this.engaged) {
      this.onEngage();
    } else if (!engaged && this.engaged) {
      this.onDisengage();
    }
    this.engaged = engaged;
  }

  private onEngage(): void {
    this.clearHoldTimer();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.holdActive = true;
      this.cb.onDown();
    }, this.holdDebounceMs);
  }

  private onDisengage(): void {
    this.clearHoldTimer();
    if (this.holdActive) {
      // Was a real hold → end it. Holds never count toward double-tap.
      this.holdActive = false;
      this.lastTapAt = 0;
      this.cb.onUp();
      return;
    }
    // Released before the hold debounce → it was a TAP.
    const now = Date.now();
    if (this.lastTapAt && now - this.lastTapAt <= this.doubleTapMs) {
      this.lastTapAt = 0;
      this.cb.onLock();
    } else {
      this.lastTapAt = now;
    }
  }

  private clearHoldTimer(): void {
    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }
}

// ─── Native listener wiring ─────────────────────────────────────────────

let started = false;
let targetWindow: BrowserWindow | null = null;
let gesture: PttGesture | null = null;

function sendToStrip(channel: string): void {
  const win = targetWindow;
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, { at: Date.now() });
  } catch (err) {
    console.warn(`[ptt] failed to send ${channel}`, err);
  }
}

/**
 * Start the global PTT listener, sending ptt.down / ptt.up / ptt.lock to the
 * given strip window. Idempotent. Safe to call when the native listener can't
 * start (logs + no-ops) so the app never crashes on a permission gap.
 */
export function startPttListener(strip: BrowserWindow): void {
  targetWindow = strip;
  if (started) return;

  gesture = new PttGesture({
    onDown: () => sendToStrip(IpcChannel.PttDown),
    onUp: () => sendToStrip(IpcChannel.PttUp),
    onLock: () => sendToStrip(IpcChannel.PttLock),
  });

  uIOhook.on('keydown', (e) => gesture?.keyDown(e.keycode));
  uIOhook.on('keyup', (e) => gesture?.keyUp(e.keycode));

  try {
    uIOhook.start();
    started = true;
    console.log(
      '[ptt] global listener started — hold ⌃⌥ to talk, double-tap to lock. ' +
        'If nothing happens, grant Input Monitoring in System Settings → Privacy & Security.',
    );
  } catch (err) {
    console.warn(
      '[ptt] uIOhook.start() failed — push-to-talk disabled. Grant Input ' +
        'Monitoring permission and relaunch.',
      err,
    );
  }
}

export function stopPttListener(): void {
  if (!started) return;
  try {
    uIOhook.stop();
  } catch (err) {
    console.warn('[ptt] uIOhook.stop() failed', err);
  }
  gesture?.reset();
  gesture = null;
  started = false;
  targetWindow = null;
}
