/**
 * Unit tests for the batch-tracking state machine inside
 * `codex-pool-core.ts`. Headless — drives the exported test hooks
 * directly without booting the Codex SDK.
 *
 * Verifies that `batch_completed` is synthesized exactly once after
 * every agent in the batch reaches `agent_finished`, that worktree
 * paths + branches are captured from `agent_started`, and that an
 * unset `batchId` is a no-op.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _batchTrackingTestHooks,
  _resetBatchTrackingForTests,
  getBatchSnapshot,
} from './codex-pool-core.js';
import type { CodexEvent } from '../shared/codex.js';

function ev(
  agentId: string,
  type: CodexEvent['type'],
  payload: Record<string, unknown> = {},
): CodexEvent {
  return { agent_id: agentId, type, payload, at: Date.now() };
}

describe('codex-pool-core batch tracking', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetBatchTrackingForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('synthesizes batch_completed once after the last agent finishes', () => {
    const seen: CodexEvent[] = [];
    const emit = (e: CodexEvent) => {
      seen.push(e);
    };

    _batchTrackingTestHooks.register('batch-1', 'maya');
    _batchTrackingTestHooks.register('batch-1', 'jin');

    _batchTrackingTestHooks.emit(
      'batch-1',
      'maya',
      emit,
      ev('maya', 'agent_started', {
        worktree: '/tmp/maya',
        branch: 'director/test/maya',
      }),
    );
    _batchTrackingTestHooks.emit(
      'batch-1',
      'jin',
      emit,
      ev('jin', 'agent_started', {
        worktree: '/tmp/jin',
        branch: 'director/test/jin',
      }),
    );

    _batchTrackingTestHooks.emit(
      'batch-1',
      'maya',
      emit,
      ev('maya', 'agent_finished', { aborted: false }),
    );
    // After maya only — no batch_completed yet.
    expect(seen.some((e) => e.type === 'batch_completed')).toBe(false);

    _batchTrackingTestHooks.emit(
      'batch-1',
      'jin',
      emit,
      ev('jin', 'agent_finished', { aborted: false }),
    );

    const batchEvents = seen.filter((e) => e.type === 'batch_completed');
    expect(batchEvents).toHaveLength(1);
    const completed = batchEvents[0];
    expect(completed).toBeDefined();
    if (!completed) throw new Error('unreachable');
    const payload = completed.payload as {
      batchId?: string;
      worktrees?: Array<{
        agentId: string;
        path: string | null;
        branch: string | null;
      }>;
    };
    expect(payload.batchId).toBe('batch-1');
    expect(payload.worktrees).toHaveLength(2);
    expect(payload.worktrees?.[0]).toEqual({
      agentId: 'maya',
      path: '/tmp/maya',
      branch: 'director/test/maya',
    });
    expect(payload.worktrees?.[1]).toEqual({
      agentId: 'jin',
      path: '/tmp/jin',
      branch: 'director/test/jin',
    });

    // Calling finish again on a finished batch must NOT re-emit.
    _batchTrackingTestHooks.emit(
      'batch-1',
      'jin',
      emit,
      ev('jin', 'agent_finished', { aborted: false }),
    );
    expect(seen.filter((e) => e.type === 'batch_completed')).toHaveLength(1);
  });

  it('no batchId → no-op tracking, no synthetic event', () => {
    const seen: CodexEvent[] = [];
    const emit = (e: CodexEvent) => {
      seen.push(e);
    };

    _batchTrackingTestHooks.register(undefined, 'solo');
    _batchTrackingTestHooks.emit(
      undefined,
      'solo',
      emit,
      ev('solo', 'agent_started', { worktree: '/tmp/solo' }),
    );
    _batchTrackingTestHooks.emit(
      undefined,
      'solo',
      emit,
      ev('solo', 'agent_finished', { aborted: false }),
    );

    expect(seen.some((e) => e.type === 'batch_completed')).toBe(false);
    expect(seen.filter((e) => e.type === 'agent_started')).toHaveLength(1);
    expect(seen.filter((e) => e.type === 'agent_finished')).toHaveLength(1);
  });

  it('getBatchSnapshot reflects registered agents + worktrees', () => {
    const emit = (_e: CodexEvent) => undefined;
    _batchTrackingTestHooks.register('batch-2', 'cleo');
    _batchTrackingTestHooks.emit(
      'batch-2',
      'cleo',
      emit,
      ev('cleo', 'agent_started', {
        worktree: '/tmp/cleo',
        branch: 'director/test/cleo',
      }),
    );

    const snap = getBatchSnapshot('batch-2');
    expect(snap).not.toBeNull();
    expect(snap?.agents).toHaveLength(1);
    expect(snap?.agents[0]).toEqual({
      agentId: 'cleo',
      worktreePath: '/tmp/cleo',
      branch: 'director/test/cleo',
      finished: false,
    });
    expect(snap?.emitted).toBe(false);
  });

  it('innerEmit error is swallowed and does not prevent batch tracking', () => {
    const seen: CodexEvent[] = [];
    let throws = true;
    const emit = (e: CodexEvent) => {
      if (throws && e.type === 'agent_finished') {
        throws = false; // only throw once so the synthetic event still lands
        throw new Error('downstream broke');
      }
      seen.push(e);
    };
    _batchTrackingTestHooks.register('batch-3', 'wren');
    _batchTrackingTestHooks.emit(
      'batch-3',
      'wren',
      emit,
      ev('wren', 'agent_started', {
        worktree: '/tmp/wren',
        branch: 'director/test/wren',
      }),
    );
    // This will trigger an inner throw, but tracking must continue.
    _batchTrackingTestHooks.emit(
      'batch-3',
      'wren',
      emit,
      ev('wren', 'agent_finished', { aborted: false }),
    );

    const synth = seen.filter((e) => e.type === 'batch_completed');
    expect(synth).toHaveLength(1);
  });
});
