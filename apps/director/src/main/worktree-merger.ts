/**
 * Worktree merger — fan-in for dispatched agent batches.
 *
 * Per docs/remaining-phases.md § 6.5 and docs/architecture.md § 6 + open Q #12.
 *
 * The orchestrator (planner) calls `mergeFanIn(...)` once all agents in a
 * dispatched batch reach `agent_finished`. The pure module:
 *
 *   1. For each worktree: captures HEAD SHA + the list of files touched
 *      relative to `main` (`git diff --name-only main...HEAD`).
 *   2. Detects whether any two worktrees touch the same path.
 *   3. Non-overlapping + `autoMergeIfNonOverlapping=true`:
 *        sequentially `git merge --no-ff --no-edit <branch>` into the
 *        integration branch. Returns the resulting integration sha.
 *      Overlapping (or auto-merge disabled): returns `{ mode: 'approval', diffs }`
 *        so the Canvas approval card (rendered by W5) can display the
 *        full per-worktree patch text to the user.
 *      Merge conflict during auto-merge: `git merge --abort`, return
 *        `{ mode: 'conflict', conflicts }`.
 *   4. Appends a `decisions.jsonl` line via `appendDecision` for audit.
 *
 * Pure Node. NO Electron. NO renderer imports. This module is the only
 * code in main that mutates the integration branch — every other touchpoint
 * (dispatch / cleanup) stays inside per-agent worktrees.
 *
 * Tests live in `worktree-merger.test.ts` next to this file.
 */

import { spawn } from 'node:child_process';
import type { AgentId } from '../shared/state.js';
import type { WorktreeHandle } from './codex-worktree.js';
import { appendDecision } from './side-store.js';

// ─── Public types ──────────────────────────────────────────────────────

export interface MergerOptions {
  /**
   * When true and no two worktrees touch the same path, the module fast-
   * forwards each branch into the integration branch in input order.
   * When false (or overlap detected), returns `{ mode: 'approval' }` with
   * per-worktree diffs for Canvas approval rendering.
   */
  autoMergeIfNonOverlapping?: boolean;
  /**
   * Branch to merge INTO. Defaults to whatever `HEAD` currently points
   * to in the host repo (`git rev-parse --abbrev-ref HEAD`).
   */
  integrationBranch?: string;
  /**
   * Override the host repo used for merge operations. Defaults to the
   * `repoRoot` of the first worktree handle. Tests use this to point at
   * a temp fixture.
   */
  repoRoot?: string;
}

export type MergeMode = 'auto-merge' | 'approval' | 'conflict';

export interface MergeDiff {
  agentId: AgentId;
  files: string[];
  /** Full `git diff main...HEAD` patch text — empty string on diff failure. */
  patch: string;
}

export interface MergeResult {
  mode: MergeMode;
  /** Final integration-branch sha after a successful auto-merge. */
  sha?: string;
  /** Agents whose worktrees participated. Always populated. */
  agents: AgentId[];
  /** Populated when `mode === 'conflict'` — file paths that conflicted. */
  conflicts?: string[];
  /** Populated when `mode === 'approval'` — per-worktree diff blocks. */
  diffs?: MergeDiff[];
  /** Populated when `mode === 'auto-merge'` — the integration branch merged into. */
  integrationBranch?: string;
}

/**
 * A worktree handle paired with the agent that produced it. Callers pass
 * this to `mergeFanIn` so decisions / diffs can be attributed correctly.
 */
export interface AttributedWorktree {
  agentId: AgentId;
  handle: WorktreeHandle;
  /** Absolute path to the host repo this worktree was added to. */
  repoRoot: string;
}

// ─── Shell helpers ─────────────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function run(
  cmd: string,
  args: string[],
  cwd?: string,
): Promise<RunResult> {
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

async function tryAppendDecision(
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await appendDecision({
      at: Date.now(),
      // The shared DecisionKind enum doesn't include 'merge' yet — using
      // the closest catch-all so we stay schema-compatible without
      // editing W1/W3-owned types in this lane.
      kind: 'other',
      payload: { merge: payload },
    });
  } catch (err) {
    // Side-store not initialized (e.g. running outside Electron) — the
    // merger remains useful for tests/dogfood without crashing.
    console.warn('[worktree-merger] appendDecision skipped:', err);
  }
}

// ─── Branch / sha / diff helpers ───────────────────────────────────────

async function currentBranch(repoRoot: string): Promise<string> {
  const res = await run(
    'git',
    ['rev-parse', '--abbrev-ref', 'HEAD'],
    repoRoot,
  );
  if (res.code !== 0) {
    throw new Error(
      `[worktree-merger] failed to read current branch in ${repoRoot}: ${res.stderr.trim()}`,
    );
  }
  return res.stdout.trim();
}

async function headSha(worktreePath: string): Promise<string | null> {
  const res = await run('git', ['rev-parse', 'HEAD'], worktreePath);
  if (res.code !== 0) return null;
  return res.stdout.trim();
}

async function diffNameOnly(
  worktreePath: string,
  integrationBranch: string,
): Promise<string[]> {
  const res = await run(
    'git',
    ['diff', '--name-only', `${integrationBranch}...HEAD`],
    worktreePath,
  );
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function diffPatch(
  worktreePath: string,
  integrationBranch: string,
): Promise<string> {
  const res = await run(
    'git',
    ['diff', `${integrationBranch}...HEAD`],
    worktreePath,
  );
  if (res.code !== 0) return '';
  return res.stdout;
}

function detectOverlap(diffs: MergeDiff[]): string[] {
  const counts = new Map<string, number>();
  for (const d of diffs) {
    for (const file of d.files) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .filter(([, n]) => n > 1)
    .map(([file]) => file);
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Merge fan-in for a completed agent batch.
 *
 * Pure function (modulo `appendDecision` side effect): given a list of
 * attributed worktrees + options, returns a structured result the caller
 * (planner / Canvas) consumes. NEVER throws on git failure — converts
 * every failure mode into a `MergeResult` shape so the caller has a
 * deterministic envelope to render.
 */
export async function mergeFanIn(
  worktrees: AttributedWorktree[],
  opts: MergerOptions = {},
): Promise<MergeResult> {
  const agents = worktrees.map((w) => w.agentId);

  if (worktrees.length === 0) {
    const result: MergeResult = { mode: 'auto-merge', agents: [] };
    await tryAppendDecision({
      mode: result.mode,
      agentIds: agents,
      note: 'empty-batch',
    });
    return result;
  }

  const first = worktrees[0];
  if (!first) {
    // Unreachable — length check above — but the type narrowing here
    // keeps noUncheckedIndexedAccess happy.
    return { mode: 'auto-merge', agents: [] };
  }
  const repoRoot = opts.repoRoot ?? first.repoRoot;
  let integrationBranch: string;
  try {
    integrationBranch =
      opts.integrationBranch ?? (await currentBranch(repoRoot));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[worktree-merger] currentBranch failed:', message);
    const result: MergeResult = {
      mode: 'conflict',
      agents,
      conflicts: [`integration-branch-unknown: ${message}`],
    };
    await tryAppendDecision({
      mode: result.mode,
      agentIds: agents,
      conflicts: result.conflicts,
    });
    return result;
  }

  // Capture HEAD sha + diff against integration for every worktree.
  const diffs: MergeDiff[] = [];
  for (const w of worktrees) {
    const sha = await headSha(w.handle.path);
    const files = await diffNameOnly(w.handle.path, integrationBranch);
    const patch = await diffPatch(w.handle.path, integrationBranch);
    diffs.push({ agentId: w.agentId, files, patch });
    if (!sha) {
      console.warn(
        `[worktree-merger] could not resolve HEAD for ${w.agentId} at ${w.handle.path}`,
      );
    }
  }

  const overlap = detectOverlap(diffs);
  const autoMerge = opts.autoMergeIfNonOverlapping === true;

  if (!autoMerge || overlap.length > 0) {
    const result: MergeResult = {
      mode: 'approval',
      agents,
      diffs,
      integrationBranch,
    };
    await tryAppendDecision({
      mode: result.mode,
      agentIds: agents,
      integrationBranch,
      overlap,
    });
    return result;
  }

  // Auto-merge path: sequentially `git merge --no-ff --no-edit <branch>`
  // each worktree into integrationBranch. On any conflict, abort and
  // return mode: 'conflict'.
  for (const w of worktrees) {
    const branch = w.handle.branch;
    const res = await run(
      'git',
      ['merge', '--no-ff', '--no-edit', branch],
      repoRoot,
    );
    if (res.code !== 0) {
      // Best-effort abort. Capture conflict file list before aborting.
      const status = await run(
        'git',
        ['diff', '--name-only', '--diff-filter=U'],
        repoRoot,
      );
      const conflicts = status.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      await run('git', ['merge', '--abort'], repoRoot);
      const result: MergeResult = {
        mode: 'conflict',
        agents,
        conflicts:
          conflicts.length > 0
            ? conflicts
            : [`merge of ${branch} failed: ${res.stderr.trim()}`],
        integrationBranch,
      };
      await tryAppendDecision({
        mode: result.mode,
        agentIds: agents,
        integrationBranch,
        conflicts: result.conflicts,
      });
      return result;
    }
  }

  const finalSha = (await headSha(repoRoot)) ?? undefined;
  const result: MergeResult = {
    mode: 'auto-merge',
    agents,
    sha: finalSha,
    integrationBranch,
  };
  await tryAppendDecision({
    mode: result.mode,
    agentIds: agents,
    integrationBranch,
    sha: finalSha,
  });
  return result;
}
