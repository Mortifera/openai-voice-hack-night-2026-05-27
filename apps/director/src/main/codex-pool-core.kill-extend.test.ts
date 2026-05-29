/**
 * Integration tests for the P6.4 hang resolution wiring inside
 * `codex-pool-core.ts`:
 *
 *   - DIRECTOR_TEST_HANG (gap 15): a named agent deliberately stalls on
 *     dispatch (skips the SDK run loop), so with a short
 *     DIRECTOR_HANG_THRESHOLD_MS the watchdog escalates headlessly.
 *   - kill_agent resolution (gap 14): `killAgentCore` archives the worktree
 *     to ~/.director/abandoned/<ts>-<agent>/ then aborts so the run loop
 *     unwinds + emits `agent_finished`.
 *   - extend_agent resolution (gap 14): `extendHangThreshold` doubles the
 *     per-agent threshold so the next escalation waits twice as long.
 *
 * Strategy: a dummy OPENAI_API_KEY is enough — `Codex.startThread()`
 * constructs a Thread object with no network/spawn (the subprocess spawns
 * only in `runStreamed`, which the hang path never calls). A throwaway git
 * repo under mkdtemp backs the real `createWorktree`. A virtual clock drives
 * the watchdog without waiting on `setInterval`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetHangWatchdogForTests,
  _tickHangWatchdogForTests,
  dispatchAgentCore,
  extendHangThreshold,
  getEffectiveHangThreshold,
  killAgentCore,
  setupHangWatchdogForTests,
  waitForAgentCore,
} from './codex-pool-core.js';
import type { CodexEvent } from '../shared/codex.js';

function gitSync(cwd: string, args: string[]): void {
  const res = spawnSync('git', args, {
    cwd,
    env: {
      ...process.env,
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
      `git ${args.join(' ')} (cwd=${cwd}) failed: ${res.stderr?.toString() ?? ''}`,
    );
  }
}

async function makeRepo(): Promise<string> {
  const repoRoot = await fs.mkdtemp(join(tmpdir(), 'director-hang-repo-'));
  gitSync(repoRoot, ['init', '-b', 'main']);
  gitSync(repoRoot, ['config', 'user.email', 'test@example.com']);
  gitSync(repoRoot, ['config', 'user.name', 'Test']);
  gitSync(repoRoot, ['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(join(repoRoot, 'README.md'), '# fixture\n', 'utf8');
  gitSync(repoRoot, ['add', '.']);
  gitSync(repoRoot, ['commit', '-m', 'base']);
  return repoRoot;
}

describe('codex-pool-core hang resolution (kill / extend / DIRECTOR_TEST_HANG)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  const originalHangEnv = process.env.DIRECTOR_TEST_HANG;
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    _resetHangWatchdogForTests();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'sk-test-dummy';
  });

  afterEach(() => {
    _resetHangWatchdogForTests();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    if (originalHangEnv === undefined) delete process.env.DIRECTOR_TEST_HANG;
    else process.env.DIRECTOR_TEST_HANG = originalHangEnv;
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  });

  it('DIRECTOR_TEST_HANG stalls the agent → watchdog fires → kill_agent archives + unwinds', async () => {
    const repoRoot = await makeRepo();
    process.env.DIRECTOR_TEST_HANG = 'maya';

    // Virtual clock so the watchdog ticks deterministically with a 200ms
    // threshold (stand-in for the production 60s).
    let now = 1_000_000;
    const seen: CodexEvent[] = [];
    setupHangWatchdogForTests({
      thresholdMs: 200,
      now: () => now,
    });

    const ack = await dispatchAgentCore(
      {
        agentId: 'maya',
        name: 'Maya',
        role: 'Frontend',
        task: 'do nothing — this agent is set to deliberately hang',
        targetRepo: repoRoot,
      },
      'hang-test-session',
      (ev) => seen.push(ev),
    );
    expect(ack.ok).toBe(true);

    // The agent_started event armed the watchdog stopwatch. Cross the
    // threshold → the synthetic hang event fires exactly once.
    now += 250;
    _tickHangWatchdogForTests();
    const fired = seen.filter((e) => e.type === 'agent_hang_suspected');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.agent_id).toBe('maya');

    // "kill it" → archive + abort. The deliberate-hang loop is parked on
    // the abort signal, so killing resolves it and the finally{} runs.
    const killRes = await killAgentCore('maya');
    expect(killRes.ok).toBe(true);
    expect(killRes.archivedTo).toBeTruthy();
    // The archive dir lives under ~/.director/abandoned/.
    expect(killRes.archivedTo).toContain(
      join(homedir(), '.director', 'abandoned'),
    );
    const archiveStat = await fs.stat(killRes.archivedTo as string);
    expect(archiveStat.isDirectory()).toBe(true);

    // The run loop unwound after abort → agent_finished emitted.
    await waitForAgentCore('maya');
    expect(seen.some((e) => e.type === 'agent_finished')).toBe(true);

    // Cleanup the archive + repo.
    await fs.rm(killRes.archivedTo as string, { recursive: true, force: true });
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  it('killAgentCore on a non-live agent returns ok:false', async () => {
    const res = await killAgentCore('nobody');
    expect(res.ok).toBe(false);
  });

  it('extendHangThreshold doubles the per-agent threshold each call', () => {
    setupHangWatchdogForTests({ thresholdMs: 60_000, now: () => 0 });
    expect(getEffectiveHangThreshold('jin')).toBe(60_000);
    expect(extendHangThreshold('jin')).toBe(120_000);
    expect(getEffectiveHangThreshold('jin')).toBe(120_000);
    // A second extend doubles again.
    expect(extendHangThreshold('jin')).toBe(240_000);
    // Other agents keep the global default.
    expect(getEffectiveHangThreshold('cleo')).toBe(60_000);
  });

  it('extend defers the next escalation past the original threshold', () => {
    let now = 2_000_000;
    const seen: CodexEvent[] = [];
    setupHangWatchdogForTests({
      emit: (e) => seen.push(e),
      thresholdMs: 100,
      now: () => now,
    });
    // Arm via a direct notify (no dispatch needed for this slice).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return import('./codex-pool-core.js').then(({ notifyEmitForHangWatchdog }) => {
      notifyEmitForHangWatchdog('wren', (e) => seen.push(e));
      now += 150;
      _tickHangWatchdogForTests();
      expect(
        seen.filter((e) => e.type === 'agent_hang_suspected'),
      ).toHaveLength(1);

      // "more time" → threshold 100 → 200, stopwatch re-armed.
      const next = extendHangThreshold('wren');
      expect(next).toBe(200);

      // 150ms later: under the NEW 200ms threshold → no re-fire.
      now += 150;
      _tickHangWatchdogForTests();
      expect(
        seen.filter((e) => e.type === 'agent_hang_suspected'),
      ).toHaveLength(1);

      // Cross 200ms → fires again.
      now += 100;
      _tickHangWatchdogForTests();
      expect(
        seen.filter((e) => e.type === 'agent_hang_suspected'),
      ).toHaveLength(2);
    });
  });
});
