import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UiohookKey } from 'uiohook-napi';
import { PttGesture } from './ptt-listener.js';

const CTRL = UiohookKey.Ctrl;
const ALT = UiohookKey.Alt;
const CTRL_R = UiohookKey.CtrlRight;
const ALT_R = UiohookKey.AltRight;
const A = UiohookKey.A;

const HOLD = 140;
const DTAP = 400;

function makeGesture() {
  const calls = { down: 0, up: 0, lock: 0 };
  const g = new PttGesture(
    {
      onDown: () => (calls.down += 1),
      onUp: () => (calls.up += 1),
      onLock: () => (calls.lock += 1),
    },
    { holdDebounceMs: HOLD, doubleTapMs: DTAP },
  );
  return { g, calls };
}

describe('PttGesture', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hold past debounce → onDown; release → onUp', () => {
    const { g, calls } = makeGesture();
    g.keyDown(CTRL);
    g.keyDown(ALT);
    expect(calls.down).toBe(0); // not yet — still within debounce
    vi.advanceTimersByTime(HOLD + 10);
    expect(calls.down).toBe(1);
    g.keyUp(ALT);
    expect(calls.up).toBe(1);
    expect(calls.lock).toBe(0);
  });

  it('quick single tap (released before debounce) → nothing', () => {
    const { g, calls } = makeGesture();
    g.keyDown(CTRL);
    g.keyDown(ALT);
    vi.advanceTimersByTime(HOLD - 50);
    g.keyUp(ALT);
    g.keyUp(CTRL);
    vi.advanceTimersByTime(1000);
    expect(calls.down).toBe(0);
    expect(calls.up).toBe(0);
    expect(calls.lock).toBe(0); // one tap is not a double-tap
  });

  it('double-tap within window → onLock once, no hold events', () => {
    const { g, calls } = makeGesture();
    // tap 1
    g.keyDown(CTRL);
    g.keyDown(ALT);
    vi.advanceTimersByTime(40);
    g.keyUp(ALT);
    g.keyUp(CTRL);
    // tap 2 within double-tap window
    vi.advanceTimersByTime(120);
    g.keyDown(CTRL);
    g.keyDown(ALT);
    vi.advanceTimersByTime(40);
    g.keyUp(ALT);
    g.keyUp(CTRL);
    expect(calls.lock).toBe(1);
    expect(calls.down).toBe(0);
    expect(calls.up).toBe(0);
  });

  it('two taps too far apart → no lock', () => {
    const { g, calls } = makeGesture();
    g.keyDown(CTRL);
    g.keyDown(ALT);
    vi.advanceTimersByTime(40);
    g.keyUp(ALT);
    g.keyUp(CTRL);
    vi.advanceTimersByTime(DTAP + 100); // exceed double-tap window
    g.keyDown(CTRL);
    g.keyDown(ALT);
    vi.advanceTimersByTime(40);
    g.keyUp(ALT);
    g.keyUp(CTRL);
    expect(calls.lock).toBe(0);
  });

  it('right-hand modifiers also engage the chord', () => {
    const { g, calls } = makeGesture();
    g.keyDown(CTRL_R);
    g.keyDown(ALT_R);
    vi.advanceTimersByTime(HOLD + 10);
    expect(calls.down).toBe(1);
    g.keyUp(CTRL_R);
    expect(calls.up).toBe(1);
  });

  it('a non-modifier key contaminates the chord → no down (Ctrl+Alt+A shortcut)', () => {
    const { g, calls } = makeGesture();
    g.keyDown(CTRL);
    g.keyDown(ALT);
    g.keyDown(A); // user is doing Ctrl+Alt+A, not push-to-talk
    vi.advanceTimersByTime(HOLD + 10);
    expect(calls.down).toBe(0);
    g.keyUp(A);
    g.keyUp(ALT);
    g.keyUp(CTRL);
    expect(calls.up).toBe(0);
  });

  it('adding a key mid-hold ends the hold (onUp fires)', () => {
    const { g, calls } = makeGesture();
    g.keyDown(CTRL);
    g.keyDown(ALT);
    vi.advanceTimersByTime(HOLD + 10);
    expect(calls.down).toBe(1);
    g.keyDown(A); // contaminate while holding
    expect(calls.up).toBe(1);
  });

  it('reset() clears state without firing onUp', () => {
    const { g, calls } = makeGesture();
    g.keyDown(CTRL);
    g.keyDown(ALT);
    vi.advanceTimersByTime(HOLD + 10);
    expect(calls.down).toBe(1);
    g.reset();
    expect(calls.up).toBe(0);
    // after reset, a fresh hold still works
    g.keyDown(CTRL);
    g.keyDown(ALT);
    vi.advanceTimersByTime(HOLD + 10);
    expect(calls.down).toBe(2);
  });
});
