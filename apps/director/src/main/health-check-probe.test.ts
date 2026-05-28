/**
 * Unit tests for `compaction-runner.runHealthCheckProbe` (Main P7.3).
 *
 * Covers the three branches called out in docs/remaining-phases.md § 7.3:
 *   - Probe answer matches side-store world state → `{ ok: true }`.
 *   - Probe answer disagrees on the goal → `{ ok: false, mismatch.goal }`.
 *   - Probe client throws (5xx / timeout / SDK gap) → `{ ok: true }` with a
 *     warning logged (non-fatal — the planner's instructions are rebuilt
 *     from disk on every consult).
 *
 * Plus a few defensive cases:
 *   - Side-store reader throws → `{ ok: true }` (degraded, non-fatal).
 *   - Probe matches goal but misses an active agent → `mismatch.agents`.
 *   - Probe matches everything but misses the recent user turn →
 *     `mismatch.lastUser`.
 *
 * Headless: no Electron, no fs, no fetch — we mock the OpenAI client and
 * pass a function `sideStoreReader` directly. The `electron` module is
 * mocked because side-store imports `ipcMain` at the top.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock electron BEFORE importing anything that pulls it in (side-store
// imports ipcMain). Same shape used by planner.test.ts.
vi.mock('electron', () => ({
  ipcMain: {
    handle: () => {},
    on: () => {},
    removeHandler: () => {},
    removeAllListeners: () => {},
  },
  BrowserWindow: class {},
}));

import { runHealthCheckProbe } from './compaction-runner.js';
import type { WorldState } from './side-store.js';

/** Mock OpenAI client whose `responses.create` returns a canned answer.
 *  Mirrors the duck-typed surface `runHealthCheckProbe` exercises. */
function buildClient(answer: string | (() => Promise<string> | string)): {
  client: unknown;
  callCount: () => number;
  lastModel: () => string | null;
} {
  let calls = 0;
  let lastModel: string | null = null;
  const client = {
    responses: {
      create: async (params: { model: string }) => {
        calls += 1;
        lastModel = params.model;
        const text = typeof answer === 'function' ? await answer() : answer;
        return { id: `resp_probe_${calls}`, output_text: text };
      },
    },
  };
  return {
    client,
    callCount: () => calls,
    lastModel: () => lastModel,
  };
}

/** Builds a throwing client. By default both primary + fallback throw,
 *  but the caller can opt to throw only on the first call. */
function buildThrowingClient(opts?: { onlyFirst?: boolean }): {
  client: unknown;
  callCount: () => number;
} {
  let calls = 0;
  const client = {
    responses: {
      create: async () => {
        calls += 1;
        if (opts?.onlyFirst && calls > 1) {
          return { id: 'resp_probe_recovered', output_text: 'goal: ship feature.' };
        }
        throw new Error('boom');
      },
    },
  };
  return { client, callCount: () => calls };
}

function buildWorld(overrides: Partial<WorldState> = {}): WorldState {
  return {
    session_id: 'test-session',
    active_agents: [],
    harness: [],
    recent_decisions: [],
    recent_transcript: [],
    current_task: null,
    last_canvas: null,
    generated_at: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  // Silence the non-fatal warnings emitted on the failure branches.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('runHealthCheckProbe — matches', () => {
  it('returns ok:true when the probe text mentions goal + agents + last user turn', async () => {
    const world = buildWorld({
      current_task: 'ship the sharing feature',
      active_agents: [
        {
          id: 'maya',
          name: 'Maya',
          role: 'Frontend',
          accentColor: '#7AC0FF',
          status: 'working',
          currentTask: null,
          taskTrail: [],
          recentFiles: [],
          blocker: null,
          worktreePath: null,
          codexThreadId: null,
          dispatchedAt: 0,
          finishedAt: null,
        },
      ],
      recent_transcript: [
        {
          id: '1',
          role: 'user',
          content: 'please plan the share link',
          timestamp: 1_700_000_000_000,
        },
      ],
    });
    const { client } = buildClient(
      [
        'Current goal: ship the sharing feature.',
        'Active agents: Maya (frontend).',
        'Most recent user instruction: please plan the share link.',
      ].join('\n'),
    );

    const result = await runHealthCheckProbe(
      client as Parameters<typeof runHealthCheckProbe>[0],
      async () => world,
    );

    expect(result.ok).toBe(true);
    expect(result.mismatch).toBeUndefined();
  });

  it('uses the default model gpt-5-mini when opts.model is not set', async () => {
    const { client, lastModel } = buildClient('goal · agents · user');
    await runHealthCheckProbe(
      client as Parameters<typeof runHealthCheckProbe>[0],
      async () => buildWorld(),
    );
    expect(lastModel()).toBe('gpt-5-mini');
  });

  it('respects opts.model when provided', async () => {
    const { client, lastModel } = buildClient('goal · agents · user');
    await runHealthCheckProbe(
      client as Parameters<typeof runHealthCheckProbe>[0],
      async () => buildWorld(),
      { model: 'gpt-5' },
    );
    expect(lastModel()).toBe('gpt-5');
  });
});

describe('runHealthCheckProbe — mismatches', () => {
  it('returns ok:false with mismatch.goal when the probe forgot the goal', async () => {
    const world = buildWorld({ current_task: 'ship the sharing feature' });
    // Probe rambles about something else entirely — no overlap with the goal tokens.
    const { client } = buildClient(
      'I am thinking about unrelated lunch options today.',
    );

    const result = await runHealthCheckProbe(
      client as Parameters<typeof runHealthCheckProbe>[0],
      async () => world,
    );

    expect(result.ok).toBe(false);
    expect(result.mismatch?.goal).toBe('ship the sharing feature');
  });

  it('returns mismatch.agents when the probe forgot an active agent', async () => {
    const world = buildWorld({
      current_task: 'optimize render perf',
      active_agents: [
        {
          id: 'jin',
          name: 'Jin',
          role: 'Backend',
          accentColor: '#7AC0FF',
          status: 'working',
          currentTask: null,
          taskTrail: [],
          recentFiles: [],
          blocker: null,
          worktreePath: null,
          codexThreadId: null,
          dispatchedAt: 0,
          finishedAt: null,
        },
      ],
    });
    const { client } = buildClient(
      [
        'Current goal: optimize render perf.',
        'No agents are active right now.',
        'No recent user instruction available.',
      ].join('\n'),
    );

    const result = await runHealthCheckProbe(
      client as Parameters<typeof runHealthCheckProbe>[0],
      async () => world,
    );

    expect(result.ok).toBe(false);
    expect(result.mismatch?.agents).toEqual(['Jin']);
    expect(result.mismatch?.goal).toBeUndefined();
  });

  it('skips agents whose status is done / error / killed / thinking', async () => {
    // Only working/spawning/blocked agents count for the diff. A done
    // agent that the probe doesn't mention should NOT trip a mismatch.
    const world = buildWorld({
      current_task: 'optimize render perf',
      active_agents: [
        {
          id: 'jin',
          name: 'Jin',
          role: 'Backend',
          accentColor: '#7AC0FF',
          status: 'done',
          currentTask: null,
          taskTrail: [],
          recentFiles: [],
          blocker: null,
          worktreePath: null,
          codexThreadId: null,
          dispatchedAt: 0,
          finishedAt: 1,
        },
      ],
    });
    const { client } = buildClient(
      'Current goal: optimize render perf. No active agents. No recent user instruction.',
    );

    const result = await runHealthCheckProbe(
      client as Parameters<typeof runHealthCheckProbe>[0],
      async () => world,
    );

    expect(result.ok).toBe(true);
  });

  it('returns mismatch.lastUser when the probe forgot the most recent user turn', async () => {
    const world = buildWorld({
      current_task: 'optimize render perf',
      recent_transcript: [
        {
          id: '1',
          role: 'assistant',
          content: 'old assistant turn',
          timestamp: 1_700_000_000_000,
        },
        {
          id: '2',
          role: 'user',
          content: 'switch to dark mode please',
          timestamp: 1_700_000_001_000,
        },
      ],
    });
    const { client } = buildClient(
      'Current goal: optimize render perf. No agents. Most recent user said: hello.',
    );

    const result = await runHealthCheckProbe(
      client as Parameters<typeof runHealthCheckProbe>[0],
      async () => world,
    );

    expect(result.ok).toBe(false);
    expect(result.mismatch?.lastUser).toBe('switch to dark mode please');
  });
});

describe('runHealthCheckProbe — failure modes', () => {
  it('returns ok:true (non-fatal) when the client throws on every attempt', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const { client, callCount } = buildThrowingClient();

    const result = await runHealthCheckProbe(
      client as Parameters<typeof runHealthCheckProbe>[0],
      async () => buildWorld({ current_task: 'anything' }),
    );

    expect(result.ok).toBe(true);
    expect(result.mismatch).toBeUndefined();
    // Both primary + fallback should have been attempted.
    expect(callCount()).toBeGreaterThanOrEqual(2);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to gpt-5 when gpt-5-mini throws and uses its answer', async () => {
    const { client, callCount } = buildThrowingClient({ onlyFirst: true });

    const result = await runHealthCheckProbe(
      client as Parameters<typeof runHealthCheckProbe>[0],
      async () => buildWorld({ current_task: 'ship feature' }),
    );

    // Goal "ship feature" matches the fallback's recovered text.
    expect(result.ok).toBe(true);
    expect(callCount()).toBe(2);
  });

  it('returns ok:true when the side-store reader throws', async () => {
    const { client } = buildClient('whatever');
    const result = await runHealthCheckProbe(
      client as Parameters<typeof runHealthCheckProbe>[0],
      async () => {
        throw new Error('disk gone');
      },
    );
    expect(result.ok).toBe(true);
  });

  it('returns ok:true when the SDK lacks a responses.create method', async () => {
    const result = await runHealthCheckProbe(
      {} as Parameters<typeof runHealthCheckProbe>[0],
      async () => buildWorld({ current_task: 'goal' }),
    );
    expect(result.ok).toBe(true);
  });
});
