import { useEffect, type JSX } from 'react';
import { DormantStrip } from './components/DormantStrip';
import { ListeningStrip } from './components/ListeningStrip';
import { SpeakingStrip } from './components/SpeakingStrip';
import { ThinkingStrip } from './components/ThinkingStrip';
import { HiveStrip } from './components/HiveStrip';
import { useRealtimeClient } from './hooks/useRealtimeClient';
import { useStore } from './state/store';
import type { StripStateKind } from '../../shared/state';
import {
  startMixtapeDemo,
  resolveJinBlocker,
  stopMixtapeDemo,
  isAwaitingResolution,
} from './state/sim';
// EscalationDetail was removed from state/sim; we now treat the
// escalation CustomEvent payload as a structural shape rather than a
// named type. W3 will reintroduce a typed contract here.
type EscalationDetail = { reason?: string; agent?: string; [k: string]: unknown };

async function devToolCall(name: string, args: Record<string, unknown>): Promise<void> {
  const bridge = window.director;
  if (!bridge?.tool) {
    console.warn('[dev] window.director.tool not exposed yet — skipping', { name, args });
    return;
  }
  try {
    const result = await bridge.tool.call({
      callId: `dev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name as never,
      args,
      realtimeItemId: `dev-item-${Date.now()}`,
    });
    console.log('[dev] tool.call', name, '→', result);
  } catch (err) {
    console.error('[dev] tool.call failed', err);
  }
}

export function App(): JSX.Element {
  const kind = useStore((s) => s.strip.kind);
  const { client, status: realtimeStatus } = useRealtimeClient();

  // Log Realtime lifecycle. W3 reflects this into store.setRealtimeStatus later.
  useEffect(() => {
    console.log(`[realtime] status → ${realtimeStatus}`);
  }, [realtimeStatus]);

  // Bridge global hotkey from main process (W1).
  useEffect(() => {
    const bridge = window.director;
    if (!bridge) return;
    return bridge.onHotkey(() => {
      // Touch the canonical store: hotkey while dormant = summon.
      const s = useStore.getState();
      if (s.strip.kind === 'dormant' || s.strip.kind === 'hive') {
        s.summon('tap');
      }
      // W1.hotkey: tap-toggle. Electron globalShortcut can't observe
      // key-up for chord keys, so the spec's hold/release is not wired
      // — kept as a TODO behind a native key listener.
      // Cold press → connect (mic defaults to tap-open).
      // Warm press → toggle mic without dropping the peer.
      if (
        client.status === 'idle' ||
        client.status === 'closed' ||
        client.status === 'error'
      ) {
        client.connect().catch((err) => {
          console.error('[realtime] connect failed', err);
        });
      } else if (client.status === 'connected') {
        const next = client.toggleMicTap();
        console.log(`[realtime] mic → ${next}`);
      }
    });
  }, [client]);

  // Listen for the sim's escalation event. The orchestration layer will
  // eventually inject a server-initiated Realtime response here; for now
  // a console log proves the pipe works.
  useEffect(() => {
    const onEscalation = (event: Event): void => {
      const ce = event as CustomEvent<EscalationDetail>;
      console.log('[escalation]', ce.detail);
    };
    window.addEventListener('director:escalation', onEscalation);
    return () => window.removeEventListener('director:escalation', onEscalation);
  }, []);

  // Dev switcher: 1/2/3/4 cycle Dormant/Listening/Speaking/Thinking;
  // 5 enters Hive; D starts the Mixtape sim; R resolves Jin; X stops;
  // T fires a single dispatch_agent_mock through the tool router;
  // H fires update_harness. Modifier-key shortcuts are ignored.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const map: Record<string, () => void> = {
        '1': () => useStore.setState({ strip: { kind: 'dormant' } }),
        '2': () =>
          useStore.setState({
            strip: { kind: 'listening', mode: 'tap', since: Date.now() },
          }),
        '3': () =>
          useStore.setState({
            strip: {
              kind: 'speaking',
              itemId: 'dev-speak',
              phase: 'commentary',
              since: Date.now(),
            },
          }),
        '4': () =>
          useStore.setState({
            strip: { kind: 'thinking', trail: [], since: Date.now() },
          }),
        '5': () =>
          useStore.setState({
            strip: { kind: 'hive', activeAgentId: null, since: Date.now() },
          }),
        '6': () =>
          useStore.setState({
            strip: {
              kind: 'escalating',
              agentId: 'jin',
              blocker: 'demo',
              since: Date.now(),
            },
          }),
        '7': () =>
          useStore.setState({
            strip: { kind: 'hive', activeAgentId: null, since: Date.now() },
          }),
        d: () => startMixtapeDemo(),
        D: () => startMixtapeDemo({ compressed: false }),
        r: () => {
          if (isAwaitingResolution()) {
            resolveJinBlocker('mock the Stripe gateway for now');
          }
        },
        R: () => {
          if (isAwaitingResolution()) {
            resolveJinBlocker('mock the Stripe gateway for now');
          }
        },
        x: () => stopMixtapeDemo(),
        X: () => stopMixtapeDemo(),
        // Tool-router smoke tests.
        t: () =>
          void devToolCall('dispatch_agent_mock', {
            name: 'Maya',
            role: 'frontend',
            task: 'PlaylistCard with flip',
          }),
        T: () =>
          void devToolCall('dispatch_agent_mock', {
            name: 'Maya',
            role: 'frontend',
            task: 'PlaylistCard with flip',
          }),
        h: () =>
          void devToolCall('update_harness', {
            rule: 'No gradients ever',
            why: 'User said so',
          }),
        H: () =>
          void devToolCall('update_harness', {
            rule: 'No gradients ever',
            why: 'User said so',
          }),
      };
      const fn = map[e.key];
      if (fn) {
        fn();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return renderStrip(kind);
}

function renderStrip(kind: StripStateKind): JSX.Element {
  switch (kind) {
    case 'dormant':
    case 'connecting':
    case 'disconnected':
    case 'error':
      return <DormantStrip />;
    case 'listening':
      return <ListeningStrip />;
    case 'speaking':
      return <SpeakingStrip />;
    case 'thinking':
      return <ThinkingStrip />;
    case 'hive':
    case 'escalating':
      return <HiveStrip />;
    default: {
      const _exhaust: never = kind;
      void _exhaust;
      return <DormantStrip />;
    }
  }
}
