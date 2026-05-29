/**
 * Unit tests for the P6.5 fan-in consumer wired into `codex-pool.ts`
 * (`onBatchCompleted`). Verifies the branching against an injected merge
 * driver (no git needed) and that retained worktree handles are released
 * after an auto-merge but KEPT on approval / conflict.
 *
 * Headless: mocks `electron` + `./canvas.js` so no app launches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => {},
    on: () => {},
    removeHandler: () => {},
    removeAllListeners: () => {},
  },
  BrowserWindow: class {
    static getAllWindows(): unknown[] {
      return [];
    }
  },
}));

const renderCanvasSpy = vi.fn();
vi.mock('./canvas.js', () => ({
  renderCanvas: (...args: unknown[]) => renderCanvasSpy(...args),
}));

import {
  _batchTrackingTestHooks,
  _resetBatchTrackingForTests,
  getBatchWorktreeHandles,
} from './codex-pool-core.js';
import { _setMergeDriverForTests, onBatchCompleted } from './codex-pool.js';
import type { WorktreeHandle } from './codex-worktree.js';
import type { CodexEvent } from '../shared/codex.js';
import type { MergeResult } from './worktree-merger.js';

function fakeHandle(agentId: string, cleanups: string[]): WorktreeHandle {
  return {
    path: `/tmp/${agentId}/worktree`,
    branch: `director/test/${agentId}`,
    cleanup: async () => {
      cleanups.push(agentId);
    },
  };
}

function batchCompletedEvent(batchId: string): CodexEvent {
  return {
    agent_id: 'maya',
    type: 'batch_completed',
    payload: { batchId, worktrees: [] },
    at: Date.now(),
  };
}

describe('codex-pool fan-in consumer (onBatchCompleted)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let restoreDriver: (() => void) | null = null;

  beforeEach(() => {
    _resetBatchTrackingForTests();
    renderCanvasSpy.mockReset();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (restoreDriver) restoreDriver();
    restoreDriver = null;
    warnSpy.mockRestore();
    logSpy.mockRestore();
    _resetBatchTrackingForTests();
  });

  it('auto-merge → releases (cleans up) all retained worktrees', async () => {
    const cleanups: string[] = [];
    _batchTrackingTestHooks.seedHandle(
      'batch-A',
      'maya',
      fakeHandle('maya', cleanups),
      '/tmp/repo',
    );
    _batchTrackingTestHooks.seedHandle(
      'batch-A',
      'jin',
      fakeHandle('jin', cleanups),
      '/tmp/repo',
    );

    const result: MergeResult = {
      mode: 'auto-merge',
      agents: ['maya', 'jin'],
      sha: 'deadbeef',
      integrationBranch: 'main',
    };
    restoreDriver = _setMergeDriverForTests(async () => result);

    await onBatchCompleted(batchCompletedEvent('batch-A'));

    expect(cleanups.sort()).toEqual(['jin', 'maya']);
    // Handles released — none retained anymore.
    expect(getBatchWorktreeHandles('batch-A').handles).toHaveLength(0);
    expect(renderCanvasSpy).not.toHaveBeenCalled();
  });

  it('approval → renders code_preview + KEEPS worktrees on disk', async () => {
    const cleanups: string[] = [];
    _batchTrackingTestHooks.seedHandle(
      'batch-B',
      'maya',
      fakeHandle('maya', cleanups),
      '/tmp/repo',
    );

    const result: MergeResult = {
      mode: 'approval',
      agents: ['maya'],
      diffs: [{ agentId: 'maya', files: ['a.txt'], patch: 'diff…', sha: 'abc' }],
      integrationBranch: 'main',
    };
    restoreDriver = _setMergeDriverForTests(async () => result);

    await onBatchCompleted(batchCompletedEvent('batch-B'));

    expect(renderCanvasSpy).toHaveBeenCalledTimes(1);
    const arg = renderCanvasSpy.mock.calls[0]?.[0] as {
      component: string;
      props: Record<string, unknown>;
    };
    expect(arg.component).toBe('code_preview');
    expect(arg.props.batchId).toBe('batch-B');
    // NOT released — kept for the user to review.
    expect(cleanups).toHaveLength(0);
    expect(getBatchWorktreeHandles('batch-B').handles).toHaveLength(1);
  });

  it('conflict → leaves all worktrees on disk + narrates', async () => {
    const cleanups: string[] = [];
    _batchTrackingTestHooks.seedHandle(
      'batch-C',
      'maya',
      fakeHandle('maya', cleanups),
      '/tmp/repo',
    );

    const result: MergeResult = {
      mode: 'conflict',
      agents: ['maya'],
      conflicts: ['shared.txt'],
      integrationBranch: 'main',
    };
    restoreDriver = _setMergeDriverForTests(async () => result);

    await onBatchCompleted(batchCompletedEvent('batch-C'));

    expect(cleanups).toHaveLength(0);
    expect(getBatchWorktreeHandles('batch-C').handles).toHaveLength(1);
    expect(renderCanvasSpy).not.toHaveBeenCalled();
  });

  it('no retained worktrees → no-op + warn', async () => {
    restoreDriver = _setMergeDriverForTests(async () => {
      throw new Error('merge should not be called');
    });
    await onBatchCompleted(batchCompletedEvent('unknown-batch'));
    expect(warnSpy).toHaveBeenCalled();
  });
});
