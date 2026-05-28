/**
 * Codex worktree manager — creates and tears down per-agent git worktrees
 * under ~/.director/sessions/<session-id>/agents/<agent-id>/worktree/.
 *
 * Each worktree is a checkout of the user's target repo. The agent works
 * in that worktree, so commits, edits, and file changes are isolated until
 * a fan-in merge at the end of the session. Branch names follow
 * `director/<sessionId>/<agentId>` so a leaked worktree is identifiable
 * and trivially diffable from `main` if the user wants to inspect it.
 *
 * See docs/research/codex-for-everything.md § 4 for the rationale (4
 * concurrent worktrees is the practical ceiling per the OpenAI docs).
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WorktreeOpts {
  /** Stable identifier for the Director session (one user dialog). */
  sessionId: string;
  /** Stable identifier for the agent (maya / jin / cleo / wren / …). */
  agentId: string;
  /** Absolute path to the user's target repo (typically examples/mixtape). */
  targetRepo: string;
  /** Defaults to `main`. */
  baseBranch?: string;
}

export interface WorktreeHandle {
  /** Absolute path to the worktree checkout. */
  path: string;
  /** Branch name the worktree is anchored on. */
  branch: string;
  /** Tear down the worktree + its branch. Safe to call multiple times. */
  cleanup: () => Promise<void>;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(cmd: string, args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) =>
      resolve({ stdout, stderr, code: code ?? -1 }),
    );
    proc.on('error', (err) =>
      resolve({ stdout, stderr: `${stderr}${err.message}`, code: -1 }),
    );
  });
}

function sessionRoot(sessionId: string): string {
  return join(homedir(), '.director', 'sessions', sessionId);
}

function agentRoot(sessionId: string, agentId: string): string {
  return join(sessionRoot(sessionId), 'agents', agentId);
}

/**
 * Create an isolated git worktree under
 * `~/.director/sessions/<sessionId>/agents/<agentId>/worktree/`.
 * Throws on git failure — caller is responsible for releasing any
 * acquired semaphore slot.
 */
export async function createWorktree(
  opts: WorktreeOpts,
): Promise<WorktreeHandle> {
  const baseBranch = opts.baseBranch ?? 'main';
  const root = agentRoot(opts.sessionId, opts.agentId);
  const worktreePath = join(root, 'worktree');
  const branch = `director/${opts.sessionId}/${opts.agentId}`;

  await fs.mkdir(root, { recursive: true });

  // If a stale worktree already lives here from a previous run, prune the
  // git metadata before re-adding. Prune is a no-op when nothing is stale.
  await run('git', ['worktree', 'prune'], opts.targetRepo);

  const result = await run(
    'git',
    ['worktree', 'add', '-B', branch, worktreePath, baseBranch],
    opts.targetRepo,
  );
  if (result.code !== 0) {
    throw new Error(
      `[codex-worktree] git worktree add failed (${result.code}): ${result.stderr.trim()}`,
    );
  }

  return {
    path: worktreePath,
    branch,
    cleanup: async () => {
      // `--force` so we can tear down even if the agent left dirty files.
      await run(
        'git',
        ['worktree', 'remove', '--force', worktreePath],
        opts.targetRepo,
      );
      // Best-effort: also delete the branch so we don't accumulate refs.
      // Failures are non-fatal (e.g., branch already gone, or the worktree
      // still references it because remove failed above).
      await run('git', ['branch', '-D', branch], opts.targetRepo);
    },
  };
}

/**
 * Diagnostic: list any worktree directories under a session root. Used by
 * future cleanup tooling to garbage-collect stale sessions.
 */
export async function listSessionWorktrees(
  sessionId: string,
): Promise<string[]> {
  try {
    const root = join(sessionRoot(sessionId), 'agents');
    const entries = await fs.readdir(root);
    return entries.map((agentId) => join(root, agentId, 'worktree'));
  } catch {
    return [];
  }
}
