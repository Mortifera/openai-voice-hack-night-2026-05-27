/**
 * Unit tests for the P6.4 hang watchdog inside `codex-pool-core.ts`.
 *
 * Strategy: bypass Codex entirely by driving the watchdog's notify hook
 * directly. A virtual clock + injected emit captures the synthetic
 * `agent_hang_suspected` event without spawning any subprocesses or
 * waiting on real time.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  _resetHangWatchdogForTests,
  _tickHangWatchdogForTests,
  notifyEmitForHangWatchdog,
  resetHangStopwatch,
  setHangAnnouncer,
  setupHangWatchdogForTests,
} from './codex-pool-core.js';
import type { CodexEvent } from '../shared/codex.js';

function makeRecorder(): {
  events: CodexEvent[];
  emit: (e: CodexEvent) => void;
} {
  const events: CodexEvent[] = [];
  return {
    events,
    emit: (e) => {
      events.push(e);
    },
  };
}

describe('codex-pool-core hang watchdog', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetHangWatchdogForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    _resetHangWatchdogForTests();
    warnSpy.mockRestore();
  });

  it('fires `agent_hang_suspected` once after the threshold elapses', () => {
    let now = 1_000_000;
    const recorder = makeRecorder();
    setupHangWatchdogForTests({
      emit: recorder.emit,
      thresholdMs: 200,
      now: () => now,
    });

    // Initial emit observation arms the stopwatch.
    notifyEmitForHangWatchdog('maya', recorder.emit);
    expect(recorder.events).toHaveLength(0);

    // Half-threshold tick — no fire.
    now += 100;
    _tickHangWatchdogForTests();
    expect(recorder.events.filter((e) => e.type === 'agent_hang_suspected'))
      .toHaveLength(0);

    // Cross the threshold → exactly one synthetic event.
    now += 200;
    _tickHangWatchdogForTests();
    const fired = recorder.events.filter(
      (e) => e.type === 'agent_hang_suspected',
    );
    expect(fired).toHaveLength(1);
    expect(fired[0]?.agent_id).toBe('maya');
    const payload = fired[0]?.payload as Record<string, unknown>;
    expect(payload.thresholdMs).toBe(200);
    expect(typeof payload.sinceMs).toBe('number');
    expect(payload.sinceMs).toBeGreaterThan(200);

    // Another tick at the same virtual time must NOT re-fire (anti-spam).
    _tickHangWatchdogForTests();
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(1);
  });

  it('respects `DIRECTOR_HANG_THRESHOLD_MS=200` via env var path', () => {
    // Verifies the env-var default-resolution code path. We don't go
    // through `setupHangWatchdogForTests` here — instead we explicitly
    // exercise the env path by resetting + setting the env var, then
    // calling `notifyEmitForHangWatchdog` which lazy-starts the watchdog
    // using `defaultThresholdMs()`.
    const originalEnv = process.env.DIRECTOR_HANG_THRESHOLD_MS;
    const originalInterval = process.env.DIRECTOR_HANG_INTERVAL_MS;
    process.env.DIRECTOR_HANG_THRESHOLD_MS = '200';
    process.env.DIRECTOR_HANG_INTERVAL_MS = '50';
    try {
      _resetHangWatchdogForTests();
      const recorder = makeRecorder();
      // Drive notify with a closure clock so we can advance time
      // manually. The watchdog stores `() => Date.now()` by default —
      // we override that via `setupHangWatchdogForTests` while keeping
      // the env-derived threshold in effect (the helper does NOT
      // override threshold if not provided).
      let now = 5_000_000;
      setupHangWatchdogForTests({
        emit: recorder.emit,
        now: () => now,
      });
      notifyEmitForHangWatchdog('jin', recorder.emit);
      now += 201;
      _tickHangWatchdogForTests();
      const fired = recorder.events.filter(
        (e) => e.type === 'agent_hang_suspected',
      );
      expect(fired).toHaveLength(1);
      expect(fired[0]?.agent_id).toBe('jin');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.DIRECTOR_HANG_THRESHOLD_MS;
      } else {
        process.env.DIRECTOR_HANG_THRESHOLD_MS = originalEnv;
      }
      if (originalInterval === undefined) {
        delete process.env.DIRECTOR_HANG_INTERVAL_MS;
      } else {
        process.env.DIRECTOR_HANG_INTERVAL_MS = originalInterval;
      }
    }
  });

  it('a subsequent emit resets the stopwatch (no re-fire until next gap)', () => {
    let now = 1_000_000;
    const recorder = makeRecorder();
    setupHangWatchdogForTests({
      emit: recorder.emit,
      thresholdMs: 200,
      now: () => now,
    });
    notifyEmitForHangWatchdog('cleo', recorder.emit);

    now += 250;
    _tickHangWatchdogForTests();
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(1);

    // Real emit lands — stopwatch resets + hangFired clears.
    notifyEmitForHangWatchdog('cleo', recorder.emit);

    // Cross half the threshold — no re-fire yet.
    now += 100;
    _tickHangWatchdogForTests();
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(1);

    // Cross the full threshold again — fires once more.
    now += 200;
    _tickHangWatchdogForTests();
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(2);
  });

  it('invokes the registered hang announcer alongside the emit', () => {
    let now = 1_000_000;
    const recorder = makeRecorder();
    const announcedFor: string[] = [];
    setupHangWatchdogForTests({
      emit: recorder.emit,
      thresholdMs: 100,
      now: () => now,
    });
    const teardown = setHangAnnouncer((agentId) => {
      announcedFor.push(agentId);
    });

    notifyEmitForHangWatchdog('wren', recorder.emit);
    now += 150;
    _tickHangWatchdogForTests();

    expect(announcedFor).toEqual(['wren']);
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(1);

    teardown();
    // After teardown the announcer no-ops but the synthetic event still fires.
    notifyEmitForHangWatchdog('wren', recorder.emit);
    now += 150;
    _tickHangWatchdogForTests();
    expect(announcedFor).toEqual(['wren']);
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(2);
  });

  it('resetHangStopwatch clears the hangFired flag so the next gap re-fires', () => {
    let now = 1_000_000;
    const recorder = makeRecorder();
    setupHangWatchdogForTests({
      emit: recorder.emit,
      thresholdMs: 100,
      now: () => now,
    });
    notifyEmitForHangWatchdog('maya', recorder.emit);
    now += 150;
    _tickHangWatchdogForTests();
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(1);

    // Simulate "more time" — bumps the clock + clears hangFired.
    resetHangStopwatch('maya');
    now += 50;
    _tickHangWatchdogForTests();
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(1);

    now += 100;
    _tickHangWatchdogForTests();
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(2);
  });

  it('announcer throwing does not block the synthetic emit', () => {
    let now = 1_000_000;
    const recorder = makeRecorder();
    setupHangWatchdogForTests({
      emit: recorder.emit,
      thresholdMs: 100,
      now: () => now,
    });
    setHangAnnouncer(() => {
      throw new Error('announcer broke');
    });

    notifyEmitForHangWatchdog('jin', recorder.emit);
    now += 150;
    _tickHangWatchdogForTests();
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(1);
  });

  it('async announcer rejection is logged without unhandled rejection', async () => {
    let now = 1_000_000;
    const recorder = makeRecorder();
    setupHangWatchdogForTests({
      emit: recorder.emit,
      thresholdMs: 100,
      now: () => now,
    });
    setHangAnnouncer(async () => {
      throw new Error('async announcer broke');
    });

    notifyEmitForHangWatchdog('cleo', recorder.emit);
    now += 150;
    _tickHangWatchdogForTests();
    // Let microtasks drain so the catch() runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(
      recorder.events.filter((e) => e.type === 'agent_hang_suspected'),
    ).toHaveLength(1);
  });
});
