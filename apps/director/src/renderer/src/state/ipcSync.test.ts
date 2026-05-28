/**
 * Unit tests for the codex.event → store-command mapper.
 *
 * Headless: drives `handleCodexEvent` directly against the canonical
 * Zustand store. No Electron / no preload bridge / no app launch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCodexEvent } from './ipcSync.js';
import { useStore } from './store.js';
import type { CodexEvent, CodexEventType } from '../../../shared/codex.js';

const MAYA = 'maya';

function resetStore(): void {
  useStore.setState({
    agents: {},
    agentOrder: [],
    strip: { kind: 'dormant' },
  });
}

function makeEvent<T extends CodexEventType>(
  type: T,
  payload: Record<string, unknown>,
  agentId: string = MAYA,
  at: number = Date.now(),
): CodexEvent {
  return { agent_id: agentId, type, payload, at };
}

describe('handleCodexEvent', () => {
  beforeEach(() => {
    resetStore();
  });

  it('agent_started seeds a new agent in `working` status with task + worktree', () => {
    handleCodexEvent(
      makeEvent('agent_started', {
        name: 'Maya',
        role: 'Frontend',
        task: 'wiring the flip animation',
        worktree: '/tmp/maya',
        branch: 'agents/maya',
      }),
    );

    const agent = useStore.getState().agents[MAYA];
    expect(agent).toBeDefined();
    expect(agent?.status).toBe('working');
    expect(agent?.name).toBe('Maya');
    expect(agent?.role).toBe('Frontend');
    expect(agent?.currentTask).toBe('wiring the flip animation');
    expect(agent?.worktreePath).toBe('/tmp/maya');
    expect(agent?.accentColor).toBe('#E07856'); // Frontend accent
    expect(agent?.taskTrail).toEqual(['wiring the flip animation']);
    expect(agent?.recentFiles).toEqual([]);
    expect(agent?.blocker).toBeNull();
  });

  it('thread_started stamps the SDK thread id onto the agent', () => {
    handleCodexEvent(
      makeEvent('agent_started', {
        name: 'Maya',
        role: 'Frontend',
        task: 't',
        worktree: '/tmp/maya',
      }),
    );

    handleCodexEvent(makeEvent('thread_started', { thread_id: 'th_abc' }));

    expect(useStore.getState().agents[MAYA]?.codexThreadId).toBe('th_abc');
  });

  it('file_change prepends paths, dedupes, and caps at 3 (newest first)', () => {
    handleCodexEvent(
      makeEvent('agent_started', {
        name: 'Maya',
        role: 'Frontend',
        task: 't',
        worktree: '/tmp/maya',
      }),
    );

    // SDK shape: payload.item.changes is an array of { path, kind }.
    const fileChange = (path: string): CodexEvent =>
      makeEvent('file_change', {
        phase: 'item.completed',
        item: {
          id: `fc-${path}`,
          type: 'file_change',
          status: 'completed',
          changes: [{ path, kind: 'update' }],
        },
      });

    handleCodexEvent(fileChange('a.ts'));
    handleCodexEvent(fileChange('b.ts'));
    handleCodexEvent(fileChange('c.ts'));
    handleCodexEvent(fileChange('d.ts'));

    expect(useStore.getState().agents[MAYA]?.recentFiles).toEqual([
      'd.ts',
      'c.ts',
      'b.ts',
    ]);
  });

  it('agent_message (item.completed) updates currentTask + appends to trail', () => {
    handleCodexEvent(
      makeEvent('agent_started', {
        name: 'Maya',
        role: 'Frontend',
        task: 'initial',
        worktree: '/tmp/maya',
      }),
    );

    handleCodexEvent(
      makeEvent('agent_message', {
        phase: 'item.completed',
        item: {
          id: 'msg-1',
          type: 'agent_message',
          text: 'wiring the flip',
        },
      }),
    );

    const agent = useStore.getState().agents[MAYA];
    expect(agent?.currentTask).toBe('wiring the flip');
    expect(agent?.taskTrail).toContain('wiring the flip');
  });

  it('error blocks the agent with the payload message', () => {
    handleCodexEvent(
      makeEvent('agent_started', {
        name: 'Jin',
        role: 'Backend',
        task: 'POST /api/generate',
        worktree: '/tmp/jin',
      }),
    );

    handleCodexEvent(
      makeEvent('error', { message: 'stripe key missing' }),
    );

    const agent = useStore.getState().agents[MAYA];
    expect(agent?.status).toBe('blocked');
    expect(agent?.blocker).toBe('stripe key missing');
  });

  it('agent_finished (natural end) completes the agent and stamps finishedAt', () => {
    handleCodexEvent(
      makeEvent('agent_started', {
        name: 'Maya',
        role: 'Frontend',
        task: 't',
        worktree: '/tmp/maya',
      }),
    );

    handleCodexEvent(makeEvent('agent_finished', { aborted: false, summary: 'done' }));

    const agent = useStore.getState().agents[MAYA];
    expect(agent?.status).toBe('done');
    expect(agent?.finishedAt).toBeTypeOf('number');
    expect(agent?.currentTask).toBe('done'); // summary lands in currentTask
  });

  it('malformed events (missing agent_id / unknown type) noop without throwing or mutating', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    handleCodexEvent(
      makeEvent('agent_started', {
        name: 'Maya',
        role: 'Frontend',
        task: 't',
        worktree: '/tmp/maya',
      }),
    );
    const before = useStore.getState().agents[MAYA];

    // Missing agent_id.
    expect(() =>
      handleCodexEvent({
        agent_id: '',
        type: 'agent_message',
        payload: { phase: 'item.completed', item: { text: 'should be ignored' } },
        at: Date.now(),
      } as CodexEvent),
    ).not.toThrow();

    // Unknown type (cast through CodexEvent — guard branches must catch it).
    expect(() =>
      handleCodexEvent({
        agent_id: MAYA,
        type: 'banana_split' as CodexEventType,
        payload: {},
        at: Date.now(),
      }),
    ).not.toThrow();

    // State should be byte-identical to the snapshot before the malformed events.
    expect(useStore.getState().agents[MAYA]).toEqual(before);

    warn.mockRestore();
  });

  it('aborted agent_finished routes through failAgent, not completeAgent', () => {
    handleCodexEvent(
      makeEvent('agent_started', {
        name: 'Maya',
        role: 'Frontend',
        task: 't',
        worktree: '/tmp/maya',
      }),
    );

    handleCodexEvent(makeEvent('agent_finished', { aborted: true }));

    const agent = useStore.getState().agents[MAYA];
    expect(agent?.status).toBe('error');
    expect(agent?.blocker).toBe('aborted');
  });
});
