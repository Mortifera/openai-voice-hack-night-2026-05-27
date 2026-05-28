/**
 * Pure reconnect schedule for the realtime client's degraded → live path.
 *
 * Lives as a standalone, dependency-free module so it can be unit-tested
 * without WebRTC, DOM, or Electron. The client (realtime/client.ts) calls
 * `nextDelay(attemptIdx)` after each failed reconnect attempt and waits
 * that many ms before retrying.
 *
 * Per docs/remaining-phases.md §6.2: 1s, 2s, 5s, 10s — then capped at 10s.
 * After 3 failed attempts (~50s total wall-clock) the FSM is expected to
 * latch into persistent degraded mode and surface the text-fallback UI;
 * the schedule itself keeps issuing 10s delays so a flaky network can
 * still recover on its own.
 */

export const RECONNECT_SCHEDULE_MS: ReadonlyArray<number> = [
  1_000,
  2_000,
  5_000,
  10_000,
] as const;

/**
 * Threshold (count of failed attempts) at which the client should latch
 * into the persistent-degraded UI per §6.2. Schedule keeps returning
 * the trailing cap delay past this point.
 */
export const PERSISTENT_DEGRADED_AFTER_ATTEMPTS = 3;

/**
 * Soft macOS notification threshold (ms of sustained disconnect) — the
 * client schedules a one-shot "Director offline" notification once total
 * outage time crosses this.
 */
export const OFFLINE_NOTIFICATION_AFTER_MS = 30_000;

/**
 * Returns the delay (ms) to wait before the next reconnect attempt.
 *
 * @param attemptIdx 0 for the first retry, 1 for the second, etc.
 * @returns ms to wait. Negative / NaN inputs round up to 0; indices past
 *          the schedule clamp at the final entry (10s).
 */
export function nextDelay(attemptIdx: number): number {
  if (!Number.isFinite(attemptIdx) || attemptIdx <= 0) {
    return RECONNECT_SCHEDULE_MS[0] ?? 1_000;
  }
  const i = Math.min(
    Math.floor(attemptIdx),
    RECONNECT_SCHEDULE_MS.length - 1,
  );
  return RECONNECT_SCHEDULE_MS[i] ?? 10_000;
}

/**
 * Returns the full schedule as an array — handy for tests + diagnostics.
 */
export function getSchedule(): readonly number[] {
  return RECONNECT_SCHEDULE_MS;
}
