/**
 * Unit tests for the realtime reconnect backoff schedule.
 *
 * Pure module → drives `nextDelay` against attempt indices. No timers,
 * no WebRTC, no DOM. Validates the 1s/2s/5s/10s ordering called out in
 * docs/remaining-phases.md §6.2.
 */

import { describe, expect, it } from 'vitest';
import {
  RECONNECT_SCHEDULE_MS,
  PERSISTENT_DEGRADED_AFTER_ATTEMPTS,
  OFFLINE_NOTIFICATION_AFTER_MS,
  nextDelay,
  getSchedule,
} from './reconnect-schedule.js';

describe('reconnect schedule', () => {
  it('schedule is exactly 1s, 2s, 5s, 10s in order', () => {
    expect(RECONNECT_SCHEDULE_MS).toEqual([1_000, 2_000, 5_000, 10_000]);
  });

  it('nextDelay returns the schedule entries for attempts 0..3', () => {
    expect(nextDelay(0)).toBe(1_000);
    expect(nextDelay(1)).toBe(2_000);
    expect(nextDelay(2)).toBe(5_000);
    expect(nextDelay(3)).toBe(10_000);
  });

  it('clamps trailing attempts at the final cap (10s)', () => {
    expect(nextDelay(4)).toBe(10_000);
    expect(nextDelay(99)).toBe(10_000);
  });

  it('treats negative / NaN / non-integer indices defensively', () => {
    expect(nextDelay(-1)).toBe(1_000);
    expect(nextDelay(Number.NaN)).toBe(1_000);
    expect(nextDelay(1.7)).toBe(2_000); // floors to 1
  });

  it('getSchedule returns the same ordering', () => {
    expect(getSchedule()).toEqual([1_000, 2_000, 5_000, 10_000]);
  });

  it('persistent-degraded threshold is 3 attempts (~50s wall-clock per spec)', () => {
    expect(PERSISTENT_DEGRADED_AFTER_ATTEMPTS).toBe(3);
    // Sanity: 1 + 2 + 5 + 10 = 18s wall-clock to reach attempt index 4,
    // which exceeds the 3-attempt latch; the offline notification threshold
    // (30s) sits between.
    const cumulativeAfter4 = RECONNECT_SCHEDULE_MS.reduce((a, b) => a + b, 0);
    expect(cumulativeAfter4).toBe(18_000);
  });

  it('offline notification fires at 30s sustained outage', () => {
    expect(OFFLINE_NOTIFICATION_AFTER_MS).toBe(30_000);
  });
});
