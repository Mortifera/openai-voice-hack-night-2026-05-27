/**
 * Unit tests for the World State Brief builder.
 *
 * Headless: drives `buildWorldStateBrief` against synthetic fixtures
 * mimicking what `readWorldState()` returns from the side store. No
 * Electron, no fs, no fetch.
 */

import { describe, expect, it } from 'vitest';
import {
  buildWorldStateBrief,
  renderBriefAsSystemText,
  type BriefSourceSnapshot,
} from './world-state-brief.js';

const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z

function makeTranscript(n: number): Array<{
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}> {
  return Array.from({ length: n }, (_, i) => ({
    id: `t-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i}`,
    timestamp: NOW - (n - i) * 1000,
  }));
}

describe('buildWorldStateBrief', () => {
  it('produces verbatim harness rules, agent statuses, goal, last canvas, last 6 transcript items, and elapsed ms', () => {
    const snapshot: BriefSourceSnapshot = {
      harness: [
        { id: 'h1', rule: 'No gradients ever.', why: 'user said', timestamp: 0, scope: 'project', source: 'user-utterance' },
        { id: 'h2', rule: 'Prefer JSON over a DB for hackathon scope.', why: '', timestamp: 0, scope: 'project', source: 'user-utterance' },
      ],
      active_agents: [
        { id: 'maya', name: 'Maya', role: 'Frontend', status: 'working', currentTask: 'wire PlaylistCard flip' },
        { id: 'jin', name: 'Jin', role: 'Backend', status: 'blocked', current_task: 'POST /api/generate' },
      ],
      current_task: 'plan the share-link feature for Mixtape',
      last_canvas: {
        component: 'moodboard',
        props_summary: 'card materials',
        awaiting_response: true,
      },
      recent_transcript: makeTranscript(10),
    };

    const brief = buildWorldStateBrief(snapshot, {
      sessionStartedAt: NOW - 55 * 60 * 1000,
      now: NOW,
      transcriptLimit: 6,
    });

    // Harness rules verbatim, in order.
    expect(brief.harnessRules).toEqual([
      'No gradients ever.',
      'Prefer JSON over a DB for hackathon scope.',
    ]);

    // Active agents + statuses preserved.
    expect(brief.activeAgents).toHaveLength(2);
    expect(brief.activeAgents[0]).toMatchObject({
      id: 'maya',
      name: 'Maya',
      role: 'Frontend',
      status: 'working',
      task: 'wire PlaylistCard flip',
    });
    expect(brief.activeAgents[1]).toMatchObject({
      id: 'jin',
      status: 'blocked',
      task: 'POST /api/generate',
    });

    // Current goal — falls back to current_task when no explicit `goal`.
    expect(brief.goal).toBe('plan the share-link feature for Mixtape');

    // Last canvas reflects what was rendered.
    expect(brief.lastCanvas?.component).toBe('moodboard');
    expect(brief.lastCanvas?.awaitingResponse).toBe(true);

    // Last 6 transcript items, newest at end.
    expect(brief.recentTranscript).toHaveLength(6);
    expect(brief.recentTranscript[0]?.id).toBe('t-4');
    expect(brief.recentTranscript[5]?.id).toBe('t-9');

    // Elapsed time honors injected `now` / `sessionStartedAt`.
    expect(brief.elapsedMs).toBe(55 * 60 * 1000);
  });

  it('returns empty / null fields when input is sparse — never throws', () => {
    const brief = buildWorldStateBrief({}, { now: NOW, sessionStartedAt: NOW });
    expect(brief.harnessRules).toEqual([]);
    expect(brief.activeAgents).toEqual([]);
    expect(brief.goal).toBeNull();
    expect(brief.lastCanvas).toBeNull();
    expect(brief.recentTranscript).toEqual([]);
    expect(brief.elapsedMs).toBe(0);
  });

  it('tolerates null/undefined snapshot input', () => {
    expect(() => buildWorldStateBrief(null)).not.toThrow();
    expect(() => buildWorldStateBrief(undefined)).not.toThrow();
    const brief = buildWorldStateBrief(null, { now: NOW, sessionStartedAt: NOW });
    expect(brief.harnessRules).toEqual([]);
    expect(brief.activeAgents).toEqual([]);
  });

  it('prefers explicit `goal` over `current_task` if both present', () => {
    const brief = buildWorldStateBrief(
      {
        goal: 'real goal',
        current_task: 'stale task field',
      },
      { now: NOW, sessionStartedAt: NOW },
    );
    expect(brief.goal).toBe('real goal');
  });

  it('caps transcript at requested limit, preserving newest', () => {
    const brief = buildWorldStateBrief(
      { recent_transcript: makeTranscript(20) },
      { now: NOW, sessionStartedAt: NOW, transcriptLimit: 4 },
    );
    expect(brief.recentTranscript).toHaveLength(4);
    expect(brief.recentTranscript[0]?.id).toBe('t-16');
    expect(brief.recentTranscript[3]?.id).toBe('t-19');
  });

  it('skips malformed transcript items without crashing', () => {
    const brief = buildWorldStateBrief(
      {
        recent_transcript: [
          { id: 'good', role: 'user', content: 'hi', timestamp: NOW },
          { not: 'a real item' } as unknown as never,
          null as unknown as never,
          { id: 'good-2', role: 'assistant', content: 'hello', timestamp: NOW + 1 },
        ],
      },
      { now: NOW, sessionStartedAt: NOW },
    );
    expect(brief.recentTranscript).toHaveLength(2);
    expect(brief.recentTranscript.map((t) => t.id)).toEqual(['good', 'good-2']);
  });
});

describe('renderBriefAsSystemText', () => {
  it('includes section headings for goal, harness, agents, canvas, transcript', () => {
    const brief = buildWorldStateBrief(
      {
        goal: 'plan share-link',
        harness: [{ id: 'h', rule: 'No gradients.', why: '', timestamp: 0, scope: 'project', source: 'user-utterance' }],
        active_agents: [{ id: 'maya', name: 'Maya', role: 'Frontend', status: 'working', currentTask: 'flip card' }],
        last_canvas: { component: 'moodboard' },
        recent_transcript: makeTranscript(2),
      },
      { now: NOW, sessionStartedAt: NOW - 5000 },
    );

    const text = renderBriefAsSystemText(brief);
    expect(text).toContain('Current goal');
    expect(text).toContain('plan share-link');
    expect(text).toContain('No gradients.');
    expect(text).toContain('Maya (Frontend, working)');
    expect(text).toContain('moodboard');
    expect(text).toContain('Recent turns');
    expect(text).toContain('5s elapsed');
  });
});
