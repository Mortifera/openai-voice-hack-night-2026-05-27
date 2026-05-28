/**
 * Unit tests for the worktree merger fan-in module.
 *
 * Headless: builds throwaway git repos under `fs.mkdtemp`, drives the
 * pure `mergeFanIn` function, and asserts on `MergeResult` envelopes.
 * NO Electron / NO renderer / NO side-store init required (the module
 * tolerates missing side-store by warning + noop'ing the decision append).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeHandle } from './codex-worktree.js';
import {
  mergeFanIn,
  type AttributedWorktree,
} from './worktree-merger.js';

// ─── Git fixture helpers (synchronous on purpose — test setup) ─────────

function gitSync(cwd: string, args: string[]): void {
  const res = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      // Force-disable any global hooks / signing so CI envs work too.
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} (cwd=${cwd}) failed: status=${res.status} stderr=${res.stderr?.toString() ?? ''}`,
    );
  }
}

function gitOut(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (res.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} (cwd=${cwd}) failed: status=${res.status} stderr=${res.stderr?.toString() ?? ''}`,
    );
  }
  return res.stdout.toString().trim();
}

async function writeFile(path: string, content: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true }).catch(() => {});
  await fs.writeFile(path, content, 'utf8');
}

interface Fixture {
  repoRoot: string;
  /** Default branch (whatever `git init` created — usually 'main' or 'master'). */
  baseBranch: string;
  cleanups: Array<() => Promise<void>>;
}

async function makeRepo(): Promise<Fixture> {
  const repoRoot = await fs.mkdtemp(join(tmpdir(), 'director-merger-repo-'));
  gitSync(repoRoot, ['init', '-b', 'main']);
  gitSync(repoRoot, ['config', 'user.email', 'test@example.com']);
  gitSync(repoRoot, ['config', 'user.name', 'Test']);
  gitSync(repoRoot, ['config', 'commit.gpgsign', 'false']);
  await writeFile(join(repoRoot, 'README.md'), '# fixture\n');
  await writeFile(join(repoRoot, 'a.txt'), 'a-base\n');
  await writeFile(join(repoRoot, 'b.txt'), 'b-base\n');
  await writeFile(join(repoRoot, 'shared.txt'), 'shared-base\n');
  gitSync(repoRoot, ['add', '.']);
  gitSync(repoRoot, ['commit', '-m', 'base']);
  return {
    repoRoot,
    baseBranch: gitOut(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    cleanups: [],
  };
}

async function addWorktree(
  fixture: Fixture,
  agentId: string,
  edits: Array<{ path: string; content: string }>,
  commitMessage: string,
): Promise<AttributedWorktree> {
  const wtRoot = await fs.mkdtemp(
    join(tmpdir(), `director-merger-wt-${agentId}-`),
  );
  // git worktree add needs the target path to NOT exist — but mkdtemp
  // already created it. Remove it, then let git recreate.
  await fs.rm(wtRoot, { recursive: true, force: true });
  const branch = `director/test/${agentId}`;
  gitSync(fixture.repoRoot, [
    'worktree',
    'add',
    '-B',
    branch,
    wtRoot,
    fixture.baseBranch,
  ]);

  for (const edit of edits) {
    await writeFile(join(wtRoot, edit.path), edit.content);
  }
  gitSync(wtRoot, ['add', '.']);
  gitSync(wtRoot, ['commit', '-m', commitMessage]);

  const handle: WorktreeHandle = {
    path: wtRoot,
    branch,
    cleanup: async () => {
      await new Promise<void>((resolve) => {
        spawnSync('git', ['worktree', 'remove', '--force', wtRoot], {
          cwd: fixture.repoRoot,
        });
        spawnSync('git', ['branch', '-D', branch], {
          cwd: fixture.repoRoot,
        });
        resolve();
      });
    },
  };

  fixture.cleanups.push(() => handle.cleanup());
  return {
    agentId,
    handle,
    repoRoot: fixture.repoRoot,
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  for (const c of fixture.cleanups) {
    await c().catch(() => {});
  }
  await fs.rm(fixture.repoRoot, { recursive: true, force: true });
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('mergeFanIn', () => {
  let fixture: Fixture;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // The merger calls `appendDecision` which requires `initSession()`
    // to have been called first. We intentionally don't init here so we
    // exercise the merger's tolerant fallback path — but we also silence
    // the expected "appendDecision skipped" warning so test output stays
    // clean. The merger's behavior IS the test target; the side-store
    // skip is a documented escape hatch for headless callers.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fixture = await makeRepo();
  });

  afterEach(async () => {
    if (fixture) await cleanupFixture(fixture);
    warnSpy.mockRestore();
  });

  it('two non-overlapping worktrees with autoMergeIfNonOverlapping=true → auto-merge', async () => {
    const wt1 = await addWorktree(
      fixture,
      'maya',
      [{ path: 'a.txt', content: 'a-maya\n' }],
      'maya edits a.txt',
    );
    const wt2 = await addWorktree(
      fixture,
      'jin',
      [{ path: 'b.txt', content: 'b-jin\n' }],
      'jin edits b.txt',
    );

    const result = await mergeFanIn([wt1, wt2], {
      autoMergeIfNonOverlapping: true,
      integrationBranch: fixture.baseBranch,
      repoRoot: fixture.repoRoot,
    });

    expect(result.mode).toBe('auto-merge');
    expect(result.agents).toEqual(['maya', 'jin']);
    expect(result.sha).toBeTypeOf('string');
    expect(result.integrationBranch).toBe(fixture.baseBranch);

    // Both edits should now be present on the integration branch.
    const aOnIntegration = await fs.readFile(
      join(fixture.repoRoot, 'a.txt'),
      'utf8',
    );
    const bOnIntegration = await fs.readFile(
      join(fixture.repoRoot, 'b.txt'),
      'utf8',
    );
    expect(aOnIntegration).toBe('a-maya\n');
    expect(bOnIntegration).toBe('b-jin\n');
  });

  it('two overlapping worktrees → approval mode with per-agent diffs', async () => {
    const wt1 = await addWorktree(
      fixture,
      'maya',
      [{ path: 'shared.txt', content: 'shared-maya\n' }],
      'maya edits shared',
    );
    const wt2 = await addWorktree(
      fixture,
      'jin',
      [{ path: 'shared.txt', content: 'shared-jin\n' }],
      'jin edits shared',
    );

    const result = await mergeFanIn([wt1, wt2], {
      autoMergeIfNonOverlapping: true,
      integrationBranch: fixture.baseBranch,
      repoRoot: fixture.repoRoot,
    });

    expect(result.mode).toBe('approval');
    expect(result.agents).toEqual(['maya', 'jin']);
    const diffs = result.diffs;
    expect(diffs).toBeDefined();
    if (!diffs) throw new Error('diffs missing');
    expect(diffs).toHaveLength(2);
    const mayaDiff = diffs[0];
    const jinDiff = diffs[1];
    if (!mayaDiff || !jinDiff) throw new Error('diff slot missing');
    expect(mayaDiff.agentId).toBe('maya');
    expect(mayaDiff.files).toContain('shared.txt');
    expect(mayaDiff.patch).toContain('shared-maya');
    expect(jinDiff.agentId).toBe('jin');
    expect(jinDiff.files).toContain('shared.txt');
    expect(jinDiff.patch).toContain('shared-jin');

    // Integration branch should be UNTOUCHED in approval mode.
    const onIntegration = await fs.readFile(
      join(fixture.repoRoot, 'shared.txt'),
      'utf8',
    );
    expect(onIntegration).toBe('shared-base\n');
  });

  it('autoMergeIfNonOverlapping=false (default) → approval mode even for non-overlapping', async () => {
    const wt1 = await addWorktree(
      fixture,
      'maya',
      [{ path: 'a.txt', content: 'a-maya\n' }],
      'maya edits a',
    );
    const wt2 = await addWorktree(
      fixture,
      'jin',
      [{ path: 'b.txt', content: 'b-jin\n' }],
      'jin edits b',
    );

    const result = await mergeFanIn([wt1, wt2], {
      integrationBranch: fixture.baseBranch,
      repoRoot: fixture.repoRoot,
    });

    expect(result.mode).toBe('approval');
    expect(result.diffs).toHaveLength(2);
    // Integration untouched.
    const aOnIntegration = await fs.readFile(
      join(fixture.repoRoot, 'a.txt'),
      'utf8',
    );
    expect(aOnIntegration).toBe('a-base\n');
  });

  it('injected merge conflict on auto-merge → conflict mode + integration restored', async () => {
    // Set up a conflict scenario:
    //   1. Bump the integration branch with a CONFLICTING edit to shared.txt.
    //   2. Then add a worktree off the OLD base that also touches shared.txt
    //      in an incompatible way. The first worktree alone will conflict
    //      when merged into the now-bumped integration branch.
    //
    // We bypass the normal "non-overlapping detection" by passing only ONE
    // worktree — overlap-detection compares worktrees to each other, not to
    // the integration branch, so a single worktree always reads as
    // "non-overlapping" and the auto-merge path runs.
    const baseRef = gitOut(fixture.repoRoot, ['rev-parse', 'HEAD']);

    const wt1 = await addWorktree(
      fixture,
      'maya',
      [{ path: 'shared.txt', content: 'shared-maya-line\n' }],
      'maya edits shared',
    );

    // Make a conflicting commit on the integration branch directly.
    await writeFile(
      join(fixture.repoRoot, 'shared.txt'),
      'shared-integration-line\n',
    );
    gitSync(fixture.repoRoot, ['add', 'shared.txt']);
    gitSync(fixture.repoRoot, ['commit', '-m', 'integration bump']);

    const result = await mergeFanIn([wt1], {
      autoMergeIfNonOverlapping: true,
      integrationBranch: fixture.baseBranch,
      repoRoot: fixture.repoRoot,
    });

    expect(result.mode).toBe('conflict');
    expect(result.agents).toEqual(['maya']);
    expect(result.conflicts).toBeDefined();
    expect(result.conflicts?.length ?? 0).toBeGreaterThan(0);

    // Integration branch should be restored to the post-bump commit (no
    // half-merged state, no MERGE_HEAD file lingering).
    const mergeHead = await fs
      .stat(join(fixture.repoRoot, '.git', 'MERGE_HEAD'))
      .then(() => true)
      .catch(() => false);
    expect(mergeHead).toBe(false);
    const onIntegration = await fs.readFile(
      join(fixture.repoRoot, 'shared.txt'),
      'utf8',
    );
    expect(onIntegration).toBe('shared-integration-line\n');

    // Sanity: the conflict didn't reset us back to base.
    const newHead = gitOut(fixture.repoRoot, ['rev-parse', 'HEAD']);
    expect(newHead).not.toBe(baseRef);
  });

  it('empty worktree list → auto-merge mode with empty agents', async () => {
    const result = await mergeFanIn([], {
      autoMergeIfNonOverlapping: true,
      integrationBranch: fixture.baseBranch,
      repoRoot: fixture.repoRoot,
    });
    expect(result.mode).toBe('auto-merge');
    expect(result.agents).toEqual([]);
    expect(result.sha).toBeUndefined();
  });
});
