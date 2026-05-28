import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { useRealtimeClient } from './hooks/useRealtimeClient';
import { useStore } from './state/store';
import {
  startMixtapeDemo,
  resolveJinBlocker,
  stopMixtapeDemo,
  isAwaitingResolution,
} from './state/sim';
import { ChatSurface, type ChatMessage } from './components/ChatSurface';
import { StripSurface } from './components/StripSurface';
import { devToolCall } from './lib/toolBridge';
import type { StripStateKind } from '../../shared/state';

// EscalationDetail was removed from state/sim; we now treat the
// escalation CustomEvent payload as a structural shape rather than a
// named type. W3 will reintroduce a typed contract here.
type EscalationDetail = { reason?: string; agent?: string; [k: string]: unknown };

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

// Strip overlay window dims per stripState — Pass 2 of docs/ux-design.md.
// Small variants stay 12×180 right-edge pills; live states (listening /
// speaking / thinking) grow to 38px; hive + escalating expand to 280×420.
const STRIP_DIMS: Record<StripStateKind, { width: number; height: number }> = {
  dormant: { width: 12, height: 180 },
  connecting: { width: 38, height: 180 },
  listening: { width: 38, height: 180 },
  speaking: { width: 38, height: 180 },
  thinking: { width: 38, height: 180 },
  hive: { width: 280, height: 420 },
  escalating: { width: 280, height: 420 },
  error: { width: 12, height: 180 },
  disconnected: { width: 12, height: 180 },
};

type Surface = 'strip' | 'chat';

function getSurface(): Surface {
  if (typeof window === 'undefined') return 'strip';
  const params = new URLSearchParams(window.location.search);
  return params.get('surface') === 'chat' ? 'chat' : 'strip';
}

function transcriptText(evt: Record<string, unknown>): string | null {
  const transcript = evt.transcript;
  if (typeof transcript !== 'string') return null;
  const text = transcript.trim();
  return text.length > 0 ? text : null;
}

export function App(): JSX.Element {
  const surface = getSurface();
  const { client, status: realtimeStatus, micStream, remoteStream } =
    useRealtimeClient();
  const stripKind = useStore((s) => s.strip.kind);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [micMode, setMicMode] = useState(client.micMode);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Log Realtime lifecycle. W3 reflects this into store.setRealtimeStatus later.
  useEffect(() => {
    console.log(`[realtime] status → ${realtimeStatus}`);
  }, [realtimeStatus]);

  // Open the Realtime peer when the shell mounts so voice/text is ready.
  // GATED to the strip surface only — the chat-debug window must NEVER auto-connect.
  // Two simultaneous Realtime peers would grab mic twice and produce overlapping AI audio.
  // See W4 P2 anomaly note + Main cross-cutting fix.
  useEffect(() => {
    if (surface !== 'strip') return;
    if (client.status !== 'idle') return;
    let cancelled = false;
    client.connect().catch((err) => {
      if (!cancelled) {
        console.error('[realtime] auto-connect failed', err);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, surface]);

  // Keep the newest transcript turn pinned in view.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages]);

  // Bridge global hotkey from main process (W1).
  // GATED to strip surface only — the global hotkey fires IPC to BOTH windows
  // (strip + chat-debug). Without this gate, both would react and we'd double-
  // grab the mic + double-fire Realtime responses.
  useEffect(() => {
    if (surface !== 'strip') return;
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
      if (client.status === 'idle' || client.status === 'closed' || client.status === 'error') {
        client.connect().catch((err) => {
          console.error('[realtime] connect failed', err);
        });
      } else if (client.status === 'connected') {
        const next = client.toggleMicTap();
        console.log(`[realtime] mic → ${next}`);
      }
    });
  }, [client, surface]);

  // ── Drive stripState from real Realtime events ─────────────────────────
  //
  //  - mic mode flips to tap-open / hold-open → setListening
  //  - response audio deltas → setSpeaking
  //  - response.done → drift back to listening (if mic still open) or rest
  //
  //  The transitions are guarded by the canonical store's allowed-from
  //  sets in store.ts §setListening / §setSpeaking, so a misfire just logs.
  useEffect(() => {
    const offMicMode = client.on('micMode', (mode) => {
      setMicMode(mode);
      const s = useStore.getState();
      if (mode === 'tap-open' || mode === 'hold-open') {
        if (
          s.strip.kind === 'dormant' ||
          s.strip.kind === 'speaking' ||
          s.strip.kind === 'hive' ||
          s.strip.kind === 'thinking'
        ) {
          s.setListening(mode === 'hold-open' ? 'hold' : 'tap');
        }
      } else if (mode === 'muted' && s.strip.kind === 'listening') {
        s.mute();
      }
    });

    let currentItemId: string | null = null;
    const offEvent = client.on('event', (evt) => {
      const type = evt.type as string | undefined;
      if (!type) return;

      if (type === 'conversation.item.input_audio_transcription.completed') {
        const text = transcriptText(evt);
        if (text) {
          setMessages((current) => [...current, { role: 'user', text }]);
        }
      }

      if (type === 'response.output_audio_transcript.done') {
        const text = transcriptText(evt);
        if (text) {
          setMessages((current) => [...current, { role: 'assistant', text }]);
        }
      }

      // First sign of model audio output → transition to speaking.
      if (
        type === 'response.output_audio.delta' ||
        type === 'response.audio.delta' ||
        type === 'response.output_audio_transcript.delta'
      ) {
        const itemId = (evt.item_id as string | undefined) ?? currentItemId ?? 'response';
        currentItemId = itemId;
        const s = useStore.getState();
        if (
          s.strip.kind === 'listening' ||
          s.strip.kind === 'thinking' ||
          s.strip.kind === 'hive' ||
          s.strip.kind === 'dormant'
        ) {
          s.setSpeaking(itemId, 'commentary');
        }
      }

      // Response finished → if the mic is still open the user can speak
      // immediately; otherwise drift toward hive (if work) or dormant.
      if (type === 'response.done') {
        currentItemId = null;
        const s = useStore.getState();
        if (s.strip.kind === 'speaking') {
          if (client.micMode === 'tap-open' || client.micMode === 'hold-open') {
            s.setListening(client.micMode === 'hold-open' ? 'hold' : 'tap');
          } else {
            s.mute();
          }
        }
      }
    });

    return () => {
      offMicMode();
      offEvent();
    };
  }, [client]);

  // Listen for the sim's escalation event and bridge it into Realtime as a
  // server-initiated response. Per docs/research/gpt-realtime-2.md §8, we
  // inject a system-role conversation item describing the blocker and the
  // resolution question, then force a `response.create` so Director speaks
  // unprompted through the existing peer connection.
  useEffect(() => {
    const onEscalation = (event: Event): void => {
      const ce = event as CustomEvent<EscalationDetail>;
      const detail = ce.detail ?? {};
      console.log('[escalation]', detail);

      const agentId =
        (detail.agent_id as string | undefined) ??
        (detail.agent as string | undefined) ??
        'an agent';
      const blocker =
        (detail.blocker as string | undefined) ??
        (detail.reason as string | undefined) ??
        'unspecified blocker';
      const suggestedQuestion =
        (detail.suggested_question as string | undefined) ?? 'How should we proceed?';

      const text =
        `An agent named ${agentId} is blocked: ${blocker}. ` +
        `Ask the user: '${suggestedQuestion}' Be brief, terse, polite.`;

      if (client.status !== 'connected' || !client.dcReady) {
        console.warn(
          `[escalation] Realtime not ready (status=${client.status}, dcReady=${client.dcReady}); skipping injection`,
        );
        return;
      }

      const okItem = client.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text }],
        },
      });
      const okResp = client.send({ type: 'response.create' });

      if (!okItem || !okResp) {
        console.warn('[escalation] data channel not open; injection partially failed');
        return;
      }

      console.log(`[escalation] dispatched: ${text}`);
    };
    window.addEventListener('director:escalation', onEscalation);
    return () => window.removeEventListener('director:escalation', onEscalation);
  }, [client]);

  // Strip auto-resize per state. Only the Strip overlay window cares about
  // resizeStrip — the Chat debug window has a normal frame and keeps its
  // fixed size. Dims live in STRIP_DIMS per Pass 2 of docs/ux-design.md.
  useEffect(() => {
    if (surface !== 'strip') return;
    const bridge = window.director;
    if (!bridge?.window?.resizeStrip) return;
    const dims = STRIP_DIMS[stripKind];
    bridge.window.resizeStrip(dims).catch((err) => {
      console.warn('[strip] resize failed', err);
    });
  }, [surface, stripKind]);

  // Dev switcher — only in development. 1-7 cycle strip states; D starts
  // the Mixtape sim; R resolves Jin; X stops; T/H fire tool-router smoke
  // tests. Real interactions (hotkey + Realtime events) drive the strip
  // in production.
  useEffect(() => {
    if (!IS_DEV) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Don't hijack typing inside text inputs (only the chat debug
      // window has one, but be defensive).
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
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

  const sendText = (): void => {
    const text = input.trim();
    if (!text) return;

    setMessages((current) => [...current, { role: 'user', text }]);
    setInput('');

    const okItem = client.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    const okResp = client.send({ type: 'response.create' });

    if (!okItem || !okResp) {
      console.warn(
        `[realtime] text send skipped because data channel is not open (status=${client.status})`,
      );
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    sendText();
  };

  const toggleMic = (): void => {
    if (client.status === 'idle' || client.status === 'closed' || client.status === 'error') {
      client.connect().catch((err) => {
        console.error('[realtime] connect failed', err);
      });
      return;
    }

    if (client.status === 'connected') {
      const next = client.toggleMicTap();
      setMicMode(next);
      console.log(`[realtime] mic → ${next}`);
    }
  };

  if (surface === 'chat') {
    return (
      <ChatSurface
        realtimeStatus={realtimeStatus}
        micMode={micMode}
        onToggleMic={toggleMic}
        messages={messages}
        messagesEndRef={messagesEndRef}
        input={input}
        onChangeInput={setInput}
        onSubmit={onSubmit}
      />
    );
  }
  return <StripSurface micStream={micStream} remoteStream={remoteStream} />;
}
