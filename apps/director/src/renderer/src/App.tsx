import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { useRealtimeClient } from './hooks/useRealtimeClient';
import { useStore } from './state/store';
import type { Agent } from '../../shared/state';
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

type ChatMessage = { role: 'user' | 'assistant'; text: string };

const matteVinylUrl = new URL('./assets/matte-vinyl.png', import.meta.url).toString();
const cassetteUrl = new URL('./assets/cassette.png', import.meta.url).toString();
const holographicUrl = new URL('./assets/holographic.png', import.meta.url).toString();
const tokyoNeonUrl = new URL('./assets/tokyo-neon.png', import.meta.url).toString();

const IS_DEV = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

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

function transcriptText(evt: Record<string, unknown>): string | null {
  const transcript = evt.transcript;
  if (typeof transcript !== 'string') return null;
  const text = transcript.trim();
  return text.length > 0 ? text : null;
}

function agentAccent(agent: Agent): string {
  const key = `${agent.id} ${agent.name}`.toLowerCase();
  if (key.includes('maya')) return 'var(--accent-maya)';
  if (key.includes('jin')) return 'var(--accent-jin)';
  if (key.includes('cleo')) return 'var(--accent-cleo)';
  if (key.includes('wren')) return 'var(--accent-wren)';
  return agent.accentColor;
}

function agentStatusFill(agent: Agent): string {
  if (agent.status === 'blocked' || agent.status === 'error') {
    return 'var(--status-blocked)';
  }
  if (agent.status === 'done' || agent.status === 'killed') {
    return 'var(--status-done)';
  }
  return 'var(--status-working)';
}

function agentTrail(agent: Agent): string {
  if (agent.status === 'blocked' && agent.blocker) return agent.blocker;
  return agent.currentTask ?? agent.taskTrail[agent.taskTrail.length - 1] ?? agent.status;
}

function statusTone(status: string): string {
  if (status === 'connected') {
    return 'border-status-working/40 bg-status-working/15 text-status-working';
  }
  if (status === 'error') {
    return 'border-status-error/40 bg-status-error/15 text-status-error';
  }
  if (status === 'connecting' || status === 'minting' || status === 'getting-mic') {
    return 'border-status-blocked/40 bg-status-blocked/15 text-status-blocked';
  }
  return 'border-border-subtle bg-white/5 text-text-secondary';
}

function showMoodboardPreset(): void {
  void devToolCall('render_canvas', {
    component_id: `chat-moodboard-${Date.now()}`,
    component: 'moodboard',
    props: {
      title: 'Card material',
      concepts: [
        {
          id: 'matte-vinyl',
          label: 'Matte Vinyl',
          description: 'Premium, monochrome, calm',
          image_url: matteVinylUrl,
        },
        {
          id: 'cassette',
          label: 'Cassette',
          description: 'Translucent amber, warm 80s',
          image_url: cassetteUrl,
        },
        {
          id: 'holographic',
          label: 'Holographic',
          description: 'Iridescent foil, playful',
          image_url: holographicUrl,
        },
      ],
    },
  });
}

function showArtifactPreset(): void {
  void devToolCall('render_canvas', {
    component_id: `chat-artifact-${Date.now()}`,
    component: 'artifact_preview',
    props: {
      title: 'Mixtape',
      notes: 'Tokyo Neon · 6 tracks',
      mixtape: {
        vibe: 'late-night drive through Tokyo neon',
        coverUrl: tokyoNeonUrl,
        tracks: [
          { title: 'Midnight Driver', artist: 'Akira Vance', runtime: '4:12' },
          { title: 'Velvet Apartment', artist: 'Noémie Hara', runtime: '3:48' },
          { title: 'Neon Rain', artist: 'Sable Sound', runtime: '5:02' },
          { title: 'Hyperreal', artist: 'Yoko & The Visa', runtime: '4:31' },
          { title: 'Lights From The Tower', artist: 'CHROMERIDER', runtime: '3:55' },
          { title: 'Akihabara Sunrise', artist: 'Aoi Tanaka', runtime: '4:24' },
        ],
      },
      actions: ['ship', 'iterate', 'discard'],
    },
  });
}

export function App(): JSX.Element {
  const { client, status: realtimeStatus } = useRealtimeClient();
  const agentsById = useStore((s) => s.agents);
  const agentOrder = useStore((s) => s.agentOrder);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [micMode, setMicMode] = useState(client.micMode);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const orderedAgentIds = new Set(agentOrder);
  const agents = agentOrder
    .map((id) => agentsById[id])
    .filter((agent): agent is Agent => Boolean(agent))
    .concat(Object.values(agentsById).filter((agent) => !orderedAgentIds.has(agent.id)));

  // Log Realtime lifecycle. W3 reflects this into store.setRealtimeStatus later.
  useEffect(() => {
    console.log(`[realtime] status → ${realtimeStatus}`);
  }, [realtimeStatus]);

  // Open the Realtime peer when the shell mounts so voice/text is ready.
  useEffect(() => {
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
  }, [client]);

  // Keep the newest transcript turn pinned in view.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages]);

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
      if (client.status === 'idle' || client.status === 'closed' || client.status === 'error') {
        client.connect().catch((err) => {
          console.error('[realtime] connect failed', err);
        });
      } else if (client.status === 'connected') {
        const next = client.toggleMicTap();
        console.log(`[realtime] mic → ${next}`);
      }
    });
  }, [client]);

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

      if (client.status !== 'connected') {
        console.warn(
          `[escalation] Realtime not connected (status=${client.status}); skipping injection`,
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

  // Dev switcher — only in development. 1-7 cycle strip states; D starts
  // the Mixtape sim; R resolves Jin; X stops; T/H fire tool-router smoke
  // tests. Real interactions (hotkey + Realtime events) drive the strip
  // in production.
  useEffect(() => {
    if (!IS_DEV) return;
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

  const isMicOpen = micMode === 'tap-open' || micMode === 'hold-open';

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

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0E0D14] font-sans text-white">
      <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center justify-between border-b border-border-subtle bg-[#0E0D14]/95 px-6">
        <h1 className="text-xl font-semibold tracking-normal text-text-primary">Director</h1>
        <span
          className={`rounded-full border px-3 py-1 text-xs font-medium ${statusTone(
            realtimeStatus,
          )}`}
        >
          {realtimeStatus}
        </span>
      </header>

      <main className="flex min-h-0 flex-1 flex-row" data-no-drag>
        <section className="flex min-w-0 flex-1 flex-col">
          <div
            className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
            role="log"
            aria-live="polite"
            aria-label="Conversation"
          >
            <div className="flex flex-col gap-3">
              {messages.map((message, index) => {
                const isUser = message.role === 'user';
                return (
                  <div
                    key={`${message.role}-${index}`}
                    className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[75%] whitespace-pre-wrap rounded-lg border px-4 py-3 text-sm leading-6 shadow-sm select-text ${
                        isUser
                          ? 'border-accent-maya/80 bg-accent-maya/10 text-text-primary'
                          : 'border-accent-jin/80 bg-accent-jin/10 text-text-primary'
                      }`}
                    >
                      {message.text}
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>
          </div>
        </section>

        <aside className="w-72 shrink-0 border-l border-border-subtle bg-surface-base px-4 py-5">
          <div className="mb-4 text-xs font-semibold uppercase tracking-[0.16em] text-text-tertiary">
            Agents
          </div>
          <div className="flex flex-col gap-2">
            {agents.length === 0 ? (
              <div className="rounded-lg border border-border-subtle px-3 py-4 text-sm text-text-tertiary">
                No agents yet
              </div>
            ) : (
              agents.map((agent) => {
                const fill = agentStatusFill(agent);
                return (
                  <div
                    key={agent.id}
                    className="rounded-lg border border-border-subtle bg-surface-elevated px-3 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          background: fill,
                          boxShadow: `0 0 0 1px ${fill}`,
                        }}
                        aria-hidden
                      />
                      <span
                        className="min-w-0 truncate text-sm font-semibold"
                        style={{ color: agentAccent(agent) }}
                      >
                        {agent.name}
                      </span>
                    </div>
                    <div className="mt-2 pl-4 text-xs leading-5 text-text-secondary italic">
                      {agentTrail(agent)}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      </main>

      <footer
        className="sticky bottom-0 z-10 shrink-0 border-t border-border-subtle bg-[#0E0D14]/95 px-5 py-4"
        data-no-drag
      >
        <form className="flex flex-wrap items-center gap-2" onSubmit={onSubmit}>
          <input
            className="min-w-72 flex-1 rounded-lg border border-border-subtle bg-surface-elevated px-4 py-3 text-sm text-text-primary outline-none transition focus:border-accent-jin/70"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Message Director"
            autoComplete="off"
            data-no-drag
          />
          <button
            type="button"
            className={`rounded-lg border px-4 py-3 text-sm font-medium transition ${
              isMicOpen
                ? 'border-status-working/60 bg-status-working/20 text-status-working'
                : 'border-border-subtle bg-white/5 text-text-secondary hover:text-text-primary'
            }`}
            onClick={toggleMic}
            data-no-drag
          >
            Mic
          </button>
          <button
            type="submit"
            className="rounded-lg border border-accent-jin/70 bg-accent-jin/20 px-4 py-3 text-sm font-semibold text-text-primary transition hover:bg-accent-jin/30 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={input.trim().length === 0}
            data-no-drag
          >
            Send
          </button>

          <div className="flex flex-wrap items-center gap-2 pl-2">
            <button
              type="button"
              className="rounded-lg border border-border-subtle bg-white/5 px-3 py-2 text-xs font-medium text-text-secondary transition hover:text-text-primary"
              onClick={() => startMixtapeDemo({ compressed: false })}
              data-no-drag
            >
              Start Mixtape Demo
            </button>
            <button
              type="button"
              className="rounded-lg border border-border-subtle bg-white/5 px-3 py-2 text-xs font-medium text-text-secondary transition hover:text-text-primary"
              onClick={() => resolveJinBlocker('mock the gateway')}
              data-no-drag
            >
              Resolve Jin
            </button>
            <button
              type="button"
              className="rounded-lg border border-border-subtle bg-white/5 px-3 py-2 text-xs font-medium text-text-secondary transition hover:text-text-primary"
              onClick={showMoodboardPreset}
              data-no-drag
            >
              Show Moodboard
            </button>
            <button
              type="button"
              className="rounded-lg border border-border-subtle bg-white/5 px-3 py-2 text-xs font-medium text-text-secondary transition hover:text-text-primary"
              onClick={showArtifactPreset}
              data-no-drag
            >
              Show Artifact
            </button>
          </div>
        </form>
      </footer>
    </div>
  );
}
