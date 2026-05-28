/**
 * Renderer-side Realtime client (WebRTC).
 *
 * Responsibilities:
 *  - Pull a fresh ephemeral token via the preload bridge (main process holds
 *    the real OPENAI_API_KEY; renderer never sees it).
 *  - Open an RTCPeerConnection with a mic track + the canonical "oai-events"
 *    data channel.
 *  - Exchange SDP with OpenAI's Realtime endpoint.
 *  - Surface a thin event-emitter API so higher layers (W3 state, W4 UI) can
 *    react to lifecycle + data-channel messages without touching WebRTC.
 *
 * This file does NOT wire tool dispatch, barge-in, or session.update — those
 * land in subsequent W1 commits (W1.session, W1.tools, W1.barge).
 *
 * Refs: docs/research/gpt-realtime-2.md §6 (transports + endpoints).
 */

import { buildSessionUpdate, type RealtimeEphemeralToken } from '../../../shared/realtime.js';
import type {
  RealtimeReconnectStatePayload,
  ToolCallRequest,
  ToolName,
} from '../../../shared/ipc.js';
import type { WorldStateBrief } from '../../../shared/state.js';
import {
  nextDelay,
  OFFLINE_NOTIFICATION_AFTER_MS,
  PERSISTENT_DEGRADED_AFTER_ATTEMPTS,
} from './reconnect-schedule.js';
import { renderBriefAsSystemText } from './brief-text.js';

const SDP_URL = 'https://api.openai.com/v1/realtime/calls';

export type RealtimeClientStatus =
  | 'idle'
  | 'minting'
  | 'getting-mic'
  | 'connecting'
  | 'connected'
  | 'closed'
  | 'error';

export type MicMode = 'muted' | 'tap-open' | 'hold-open';

export interface RealtimeStreams {
  /** Live mic capture. Null until the renderer has microphone access. */
  mic: MediaStream | null;
  /** Remote audio track from OpenAI. Null until the peer sends `track`. */
  remote: MediaStream | null;
}

export interface RealtimeClientEvents {
  status: RealtimeClientStatus;
  event: Record<string, unknown>; // any JSON event off oai-events
  error: Error;
  micMode: MicMode;
  /** Fires when the mic or remote MediaStream becomes available / goes away. */
  streams: RealtimeStreams;
}

type Listener<T> = (payload: T) => void;

export class RealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private micStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteAudio: HTMLAudioElement | null = null;
  private listeners: { [K in keyof RealtimeClientEvents]: Set<Listener<unknown>> } = {
    status: new Set(),
    event: new Set(),
    error: new Set(),
    micMode: new Set(),
    streams: new Set(),
  };
  private _status: RealtimeClientStatus = 'idle';
  private _micMode: MicMode = 'muted';
  /** call_id → { name, itemId } captured from response.output_item.added so
   *  we can resolve names when only `function_call_arguments.done` fires. */
  private pendingCalls: Map<string, { name: string; itemId: string }> = new Map();

  // ─── § rotation + reconnect (W2 — P6.1 + P6.2) ─────────────────────────
  /** Standby peer connection during rotation. Becomes the primary on swap. */
  private rotatingPc: RTCPeerConnection | null = null;
  private rotatingDc: RTCDataChannel | null = null;
  private rotatingStream: MediaStream | null = null;
  private rotatingAudio: HTMLAudioElement | null = null;
  private rotationInFlight = false;

  /** Reconnect FSM state. */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private outageStartedAt: number | null = null;
  private offlineNotificationSent = false;
  private degraded = false;
  /** Last user utterance text held in case the peer dropped mid-VAD. Replays
   *  on reconnect via `conversation.item.create` + `response.create`. */
  private pendingUtterance: string | null = null;
  /** Auto-reconnect can be disabled by callers (tests, manual close). */
  private autoReconnect = true;

  get status(): RealtimeClientStatus {
    return this._status;
  }

  get micMode(): MicMode {
    return this._micMode;
  }

  /** Current mic + remote streams. Either may be null while not connected. */
  getStreams(): RealtimeStreams {
    return { mic: this.micStream, remote: this.remoteStream };
  }

  private emitStreams(): void {
    this.emit('streams', { mic: this.micStream, remote: this.remoteStream });
  }

  on<K extends keyof RealtimeClientEvents>(
    name: K,
    cb: Listener<RealtimeClientEvents[K]>,
  ): () => void {
    this.listeners[name].add(cb as Listener<unknown>);
    return () => this.listeners[name].delete(cb as Listener<unknown>);
  }

  private emit<K extends keyof RealtimeClientEvents>(
    name: K,
    payload: RealtimeClientEvents[K],
  ): void {
    for (const cb of this.listeners[name]) {
      try {
        (cb as Listener<RealtimeClientEvents[K]>)(payload);
      } catch (err) {
        // Never let a listener crash the client.
        console.error('[realtime] listener threw', err);
      }
    }
  }

  private setStatus(next: RealtimeClientStatus): void {
    if (this._status === next) return;
    this._status = next;
    this.emit('status', next);
  }

  /**
   * Server-event dispatcher. Pulls out:
   *   - lifecycle (session.created/updated, error) → console
   *   - function-call lifecycle (output_item.added with function_call →
   *     remember name; function_call_arguments.done → dispatch over IPC)
   *   - barge-in (input_audio_buffer.speech_started → response.cancel)
   * Anything we don't special-case falls through to listeners via emit('event').
   */
  private handleServerEvent(parsed: Record<string, unknown>): void {
    const type = parsed.type as string | undefined;
    if (!type) return;

    if (type === 'session.created' || type === 'session.updated' || type === 'error') {
      console.log(`[realtime] ${type}`, parsed);
    }

    // Remember name + item_id when a function_call item appears, so we can
    // resolve the name later when only `.done` fires with call_id.
    if (type === 'response.output_item.added') {
      const item = parsed.item as
        | { type?: string; name?: string; call_id?: string; id?: string }
        | undefined;
      if (item?.type === 'function_call' && item.call_id && item.name) {
        this.pendingCalls.set(item.call_id, {
          name: item.name,
          itemId: item.id ?? '',
        });
      }
    }

    // Dispatch fully-assembled function call.
    if (type === 'response.function_call_arguments.done') {
      const callId = parsed.call_id as string | undefined;
      const argsRaw = parsed.arguments as string | undefined;
      const nameFromEvent = parsed.name as string | undefined; // some shapes include name here
      if (callId) {
        const pending = this.pendingCalls.get(callId);
        const name = nameFromEvent ?? pending?.name;
        const itemId = pending?.itemId ?? '';
        if (!name) {
          console.warn(`[realtime] function_call_arguments.done without name (callId=${callId})`);
          return;
        }
        let args: unknown = {};
        try {
          args = argsRaw ? JSON.parse(argsRaw) : {};
        } catch (err) {
          console.warn('[realtime] failed to parse tool arguments JSON', err, argsRaw);
        }
        this.pendingCalls.delete(callId);
        void this.dispatchTool({ callId, name: name as ToolName, args, realtimeItemId: itemId });
      }
    }

    // W1.barge: user started speaking while the model was speaking → cancel
    // the in-flight response. The server-side `interrupt_response: true`
    // also handles this, but sending explicit cancel cuts ~50–100ms.
    if (type === 'input_audio_buffer.speech_started') {
      this.send({ type: 'response.cancel' });
    }
  }

  /**
   * Forward a model tool call to main via IPC, wait for the stub result,
   * then push it back into the conversation as a `function_call_output` +
   * `response.create`. W3/W4 will replace the stub with real handlers.
   */
  private async dispatchTool(req: ToolCallRequest): Promise<void> {
    console.log(`[realtime] tool.call → main name=${req.name} callId=${req.callId}`);
    const bridge = window.director;
    if (!bridge) {
      console.warn('[realtime] no preload bridge; dropping tool call');
      return;
    }
    try {
      const result = await bridge.tool.call(req);
      // Always feed *something* back so the model isn't left hanging.
      const output = result.ok ? result.output : { error: result.error };
      const sentItem = this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: req.callId,
          output: JSON.stringify(output),
        },
      });
      const sentResp = this.send({ type: 'response.create' });
      // Slow tools (consult_director hits gpt-5 for 3–8s) can outlast the
      // data-channel. If send fails the model hangs silently waiting for
      // the function_call_output. Surface the drop so we notice.
      if (!sentItem || !sentResp) {
        console.warn(
          `[realtime] tool.result inject dropped (sentItem=${sentItem}, sentResp=${sentResp}, callId=${req.callId}, name=${req.name}) — DC closed mid-call`,
        );
      }
    } catch (err) {
      console.error('[realtime] tool dispatch failed', err);
      // Best-effort error injection so the model can continue.
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: req.callId,
          output: JSON.stringify({ error: String(err) }),
        },
      });
      this.send({ type: 'response.create' });
    }
  }

  /**
   * Connect end-to-end. Idempotent in error states: call close() first if
   * you want a clean retry.
   */
  async connect(token?: RealtimeEphemeralToken): Promise<void> {
    if (this._status === 'connected' || this._status === 'connecting') {
      throw new Error(`[realtime] cannot connect from status=${this._status}`);
    }

    try {
      // 1. Mint token (unless caller pre-minted).
      this.setStatus('minting');
      const bridge = window.director;
      if (!bridge) throw new Error('window.director bridge missing (non-Electron context?)');
      const realtimeToken = token ?? (await bridge.realtime.mintToken({}));

      // 2. Mic capture. Default mode 'tap-open' — the first hotkey press
      // that triggered connect IS the user's open-mic gesture.
      this.setStatus('getting-mic');
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.emitStreams();
      // Force the event to fire so subscribers see the initial mode.
      this._micMode = 'muted';
      this.setMicMode('tap-open');

      // 3. PeerConnection.
      this.setStatus('connecting');
      const pc = new RTCPeerConnection();
      this.pc = pc;

      // Remote audio: OpenAI sends model audio back as a track. Wire it
      // into a hidden <audio> element so it actually plays.
      pc.ontrack = (evt) => {
        if (!this.remoteAudio) {
          const el = document.createElement('audio');
          el.autoplay = true;
          el.style.display = 'none';
          document.body.appendChild(el);
          this.remoteAudio = el;
        }
        const stream = evt.streams[0] ?? new MediaStream([evt.track]);
        this.remoteAudio.srcObject = stream;
        this.remoteStream = stream;
        this.emitStreams();
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') {
          this.setStatus('connected');
          this.onConnectionRecovered();
        } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          // Only downgrade if we were live; ignore transient "closed" before connect.
          if (this._status === 'connected') {
            this.setStatus('closed');
            this.onConnectionLost(`pc.connectionState=${s}`);
          }
        }
      };

      // ICE-level failure detection (P6.2). The browser surfaces brief
      // network outages here long before `pc.connectionState` flips. We
      // only flip into degraded mode on `failed` / `disconnected` —
      // `checking` is normal during candidate gather.
      pc.oniceconnectionstatechange = () => {
        const ice = pc.iceConnectionState;
        if (ice === 'failed' || ice === 'disconnected') {
          this.onConnectionLost(`iceConnectionState=${ice}`);
        }
      };

      // Add mic track(s).
      for (const track of this.micStream.getAudioTracks()) {
        pc.addTrack(track, this.micStream);
      }

      // Data channel (canonical name).
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onopen = () => {
        // connectionState may flip after the DC opens — promote here too.
        if (pc.connectionState === 'connected') this.setStatus('connected');
        // Belt-and-braces: re-affirm session config now that the channel is
        // confirmed open. The mint config already sets these, so the model
        // will usually ack with `session.updated` containing no diff.
        const update = buildSessionUpdate();
        try {
          dc.send(JSON.stringify(update));
          console.log('[realtime] sent session.update on channel open');
        } catch (err) {
          console.warn('[realtime] failed to send session.update', err);
        }
      };
      dc.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as Record<string, unknown>;
          this.handleServerEvent(parsed);
          this.emit('event', parsed);
        } catch (err) {
          console.warn('[realtime] non-JSON event', err, evt.data);
        }
      };
      dc.onerror = (evt) => {
        const err = (evt as RTCErrorEvent).error ?? new Error('data channel error');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      };
      // P6.2: data-channel close → degraded. Bare close mid-session means
      // the remote tore down the WebRTC bus (server-side network blip,
      // proxy reset). Trigger the same retry path as ICE failure.
      dc.onclose = () => {
        if (this._status === 'connected') {
          this.onConnectionLost('dataChannel.close');
        }
      };

      // 4. SDP offer → POST → answer.
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!offer.sdp) throw new Error('createOffer produced no SDP');

      const sdpRes = await fetch(SDP_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${realtimeToken.value}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });

      if (!sdpRes.ok) {
        const text = await sdpRes.text().catch(() => '<no body>');
        throw new Error(`[realtime] SDP exchange failed: HTTP ${sdpRes.status} — ${text}`);
      }

      const answerSdp = await sdpRes.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      // connectionState transition is async — onconnectionstatechange will
      // promote us to 'connected'. If it already happened, no-op.
    } catch (err) {
      this.setStatus('error');
      const e = err instanceof Error ? err : new Error(String(err));
      this.emit('error', e);
      this.close();
      throw e;
    }
  }

  /**
   * Set mic mode and apply it to the underlying track.enabled flag.
   * - 'muted' → track.enabled = false (silence; peer stays open)
   * - 'tap-open' | 'hold-open' → track.enabled = true
   * Caller (App) decides which mode based on smart-key gesture.
   */
  setMicMode(mode: MicMode): void {
    if (this._micMode === mode) return;
    this._micMode = mode;
    if (this.micStream) {
      const enabled = mode !== 'muted';
      for (const track of this.micStream.getAudioTracks()) {
        track.enabled = enabled;
      }
    }
    this.emit('micMode', mode);

    // Broadcast over IPC so other windows (Canvas, future status surfaces)
    // can react. The bridge may be absent in non-Electron contexts.
    const bridge = window.director;
    if (bridge?.mic) {
      try {
        bridge.mic.setStatus({ state: mode, inputLevel: 0 });
      } catch (err) {
        console.warn('[realtime] mic.setStatus failed', err);
      }
    }
  }

  /** Toggle between muted and tap-open. No-op if mic stream missing. */
  toggleMicTap(): MicMode {
    const next: MicMode = this._micMode === 'muted' ? 'tap-open' : 'muted';
    this.setMicMode(next);
    return next;
  }

  /**
   * Send a JSON event over the data channel. No-op if the channel isn't open
   * yet — caller should gate on status === 'connected' AND `dcReady`.
   */
  send(event: Record<string, unknown>): boolean {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    this.dc.send(JSON.stringify(event));
    return true;
  }

  /**
   * True when the WebRTC data channel is fully open and writable. There's a
   * window between status='connected' and DC open where send() silently
   * returns false — escalation injection callers must check this guard
   * before sending paired item+response.create messages.
   */
  get dcReady(): boolean {
    return this.dc?.readyState === 'open';
  }

  close(): void {
    // Manual close → disable auto-reconnect so we don't fight the user.
    this.autoReconnect = false;
    this.clearReconnectTimer();
    this.teardownRotationPeer('manual close');
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
    }
    if (this.remoteAudio && this.remoteAudio.parentNode) {
      this.remoteAudio.parentNode.removeChild(this.remoteAudio);
    }
    this.dc = null;
    this.pc = null;
    this.micStream = null;
    this.remoteStream = null;
    this.remoteAudio = null;
    this.emitStreams();
    this.setStatus('closed');
  }

  // ─── § rotation (W2 — P6.1) ────────────────────────────────────────────

  /**
   * Whether a rotation is in flight (Session_B mint + brief delivery happening).
   * App can read this to suppress duplicate rotation triggers from the FSM.
   */
  get isRotating(): boolean {
    return this.rotationInFlight;
  }

  /**
   * Buffer the current in-flight user utterance. Caller (App) invokes when
   * the renderer observes `input_audio_buffer.speech_started` and keeps
   * the text-version available via the live transcription event.
   *
   * On reconnect, the buffered text is replayed so the user doesn't have
   * to repeat themselves.
   */
  setPendingUtterance(text: string | null): void {
    this.pendingUtterance = text && text.trim().length > 0 ? text.trim() : null;
  }

  /**
   * Trigger session rotation at T+55. Returns true if a swap was attempted;
   * false on mint / SDP / brief delivery failure (caller surfaces the
   * fallback notification at T+59:30 per spec).
   *
   * Defensive: any thrown error is caught; rotating peer is torn down so
   * a failed rotation doesn't leak resources.
   */
  async triggerRotation(): Promise<boolean> {
    if (this.rotationInFlight) {
      console.warn('[realtime] rotation already in flight — ignoring duplicate trigger');
      return false;
    }
    if (this._status !== 'connected') {
      console.warn(`[realtime] cannot rotate from status=${this._status}`);
      return false;
    }
    const bridge = window.director;
    if (!bridge?.realtimeRotation) {
      console.warn('[realtime] bridge.realtimeRotation missing — cannot rotate');
      return false;
    }

    this.rotationInFlight = true;
    try {
      // 1. Ask main for Session_B token + the World State Brief.
      const requestId = `rot-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const res = await bridge.realtimeRotation.requestRotation({ requestId });
      if (!res || res.ok !== true) {
        console.warn(
          '[realtime] rotation request failed',
          res && 'error' in res ? res.error : '<no body>',
        );
        return false;
      }

      // 2. Open Session_B peer + data channel.
      const nextPc = new RTCPeerConnection();
      this.rotatingPc = nextPc;
      // We don't add the mic track to Session_B yet — we only swap once the
      // brief is ack'd and we hit a silent window. Caller can then call
      // `swapToRotatingPeer()`. For now, build a placeholder track via
      // the existing mic stream so SDP includes audio.
      if (this.micStream) {
        // Clone the existing mic track. Cloning means we can mute it during
        // setup without affecting Session_A's mic. We'll replace via addTrack
        // again on swap.
        for (const t of this.micStream.getAudioTracks()) {
          try {
            const cloned = t.clone();
            cloned.enabled = false; // muted while standby
            nextPc.addTrack(cloned, this.micStream);
          } catch (err) {
            console.warn('[realtime] mic track clone failed; rotation may be silent', err);
          }
        }
      }

      // Capture remote audio from Session_B into a hidden <audio> element.
      // Don't promote it as the active remote stream until swap.
      const stagedAudio = document.createElement('audio');
      stagedAudio.autoplay = false;
      stagedAudio.style.display = 'none';
      document.body.appendChild(stagedAudio);
      this.rotatingAudio = stagedAudio;
      nextPc.ontrack = (evt) => {
        const stream = evt.streams[0] ?? new MediaStream([evt.track]);
        stagedAudio.srcObject = stream;
        this.rotatingStream = stream;
      };

      const nextDc = nextPc.createDataChannel('oai-events');
      this.rotatingDc = nextDc;
      let briefAck: ((value: boolean) => void) | null = null;
      const briefAckPromise = new Promise<boolean>((resolve) => {
        briefAck = resolve;
      });
      nextDc.onopen = () => {
        // Replay session.update + brief as system role item.
        try {
          nextDc.send(JSON.stringify(buildSessionUpdate()));
          nextDc.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: renderBriefAsSystemText(res.brief) }],
              },
            }),
          );
        } catch (err) {
          console.warn('[realtime] failed to send brief to Session_B', err);
          briefAck?.(false);
        }
      };
      nextDc.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as Record<string, unknown>;
          const type = parsed.type as string | undefined;
          if (type === 'conversation.item.created') briefAck?.(true);
        } catch {
          /* tolerate non-JSON */
        }
      };
      nextDc.onerror = () => briefAck?.(false);

      // 3. SDP exchange against Session_B.
      const offer = await nextPc.createOffer();
      await nextPc.setLocalDescription(offer);
      if (!offer.sdp) throw new Error('createOffer (rotation) produced no SDP');

      const sdpRes = await fetch(SDP_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${res.newToken}`,
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      });
      if (!sdpRes.ok) {
        const text = await sdpRes.text().catch(() => '<no body>');
        throw new Error(`[realtime] rotation SDP failed: HTTP ${sdpRes.status} — ${text}`);
      }
      const answer = await sdpRes.text();
      await nextPc.setRemoteDescription({ type: 'answer', sdp: answer });

      // 4. Wait briefly for brief ack (or timeout). 2s budget is comfortable
      //    against the spec's <200ms swap latency on top of an open DC.
      const ack = await Promise.race([
        briefAckPromise,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      if (!ack) {
        console.warn('[realtime] brief ack timed out — staying on Session_A');
        this.teardownRotationPeer('brief ack timeout');
        return false;
      }

      // 5. Caller is responsible for invoking `swapToRotatingPeer()` at the
      //    next VAD-silent window. Auto-swap immediately if already silent.
      //    For now we swap straight away; the App may later observe
      //    `input_audio_buffer.speech_stopped` and call us.
      this.swapToRotatingPeer();
      return true;
    } catch (err) {
      console.warn('[realtime] rotation failed', err);
      this.teardownRotationPeer('caught error');
      return false;
    } finally {
      this.rotationInFlight = false;
    }
  }

  /**
   * Swap the active peer connection from Session_A → Session_B. Caller
   * (App) invokes at the next ~200ms VAD-silent window. Idempotent —
   * no-op if no rotating peer exists.
   */
  swapToRotatingPeer(): boolean {
    if (!this.rotatingPc || !this.rotatingDc || !this.rotatingAudio) {
      return false;
    }

    // Teardown Session_A. Close the data channel first so an in-flight
    // model response is cancelled before we kill the peer.
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    if (this.remoteAudio && this.remoteAudio.parentNode) {
      try {
        this.remoteAudio.parentNode.removeChild(this.remoteAudio);
      } catch {
        /* ignore */
      }
    }

    // Promote rotating → active.
    this.pc = this.rotatingPc;
    this.dc = this.rotatingDc;
    this.remoteAudio = this.rotatingAudio;
    this.remoteStream = this.rotatingStream;
    this.rotatingPc = null;
    this.rotatingDc = null;
    this.rotatingAudio = null;
    this.rotatingStream = null;

    // Wire generic dc.onmessage / status handlers on the promoted DC. The
    // ones we set during rotation only resolved the brief-ack promise.
    if (this.dc) {
      this.dc.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data) as Record<string, unknown>;
          this.handleServerEvent(parsed);
          this.emit('event', parsed);
        } catch (err) {
          console.warn('[realtime] non-JSON event (post-rotation)', err, evt.data);
        }
      };
      this.dc.onclose = () => {
        if (this._status === 'connected') {
          this.onConnectionLost('dataChannel.close (post-rotation)');
        }
      };
      this.dc.onerror = (evt) => {
        const err = (evt as RTCErrorEvent).error ?? new Error('data channel error');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      };
    }

    // Activate audio playback on the new <audio>.
    if (this.remoteAudio) {
      this.remoteAudio.autoplay = true;
      void this.remoteAudio.play().catch(() => {
        /* autoplay may need a gesture; tolerate */
      });
    }

    // Wire ICE/connection-state listeners on the promoted peer so we keep
    // observing degradations.
    if (this.pc) {
      this.pc.onconnectionstatechange = () => {
        const s = this.pc?.connectionState;
        if (s === 'connected') {
          this.setStatus('connected');
          this.onConnectionRecovered();
        } else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          if (this._status === 'connected') {
            this.setStatus('closed');
            this.onConnectionLost(`pc.connectionState=${s} (post-rotation)`);
          }
        }
      };
      this.pc.oniceconnectionstatechange = () => {
        const ice = this.pc?.iceConnectionState;
        if (ice === 'failed' || ice === 'disconnected') {
          this.onConnectionLost(`iceConnectionState=${ice} (post-rotation)`);
        }
      };
    }

    this.emitStreams();
    return true;
  }

  private teardownRotationPeer(reason: string): void {
    if (this.rotatingDc) {
      try {
        this.rotatingDc.close();
      } catch {
        /* ignore */
      }
    }
    if (this.rotatingPc) {
      try {
        this.rotatingPc.close();
      } catch {
        /* ignore */
      }
    }
    if (this.rotatingAudio && this.rotatingAudio.parentNode) {
      try {
        this.rotatingAudio.parentNode.removeChild(this.rotatingAudio);
      } catch {
        /* ignore */
      }
    }
    this.rotatingPc = null;
    this.rotatingDc = null;
    this.rotatingAudio = null;
    this.rotatingStream = null;
    if (reason && reason !== 'manual close') {
      console.log(`[realtime] rotation peer torn down: ${reason}`);
    }
  }

  // ─── § reconnect (W2 — P6.2) ───────────────────────────────────────────

  /**
   * Whether the client believes itself to be degraded (peer dropped, retry
   * loop running). Read by App.tsx via store.setRealtimeStatus('degraded').
   */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Wall-clock ms since the disconnect started. 0 when not degraded.
   */
  get outageMs(): number {
    return this.outageStartedAt == null ? 0 : Date.now() - this.outageStartedAt;
  }

  private onConnectionLost(reason: string): void {
    if (this.degraded) return; // already in degraded path
    if (!this.autoReconnect) return;
    this.degraded = true;
    this.outageStartedAt = this.outageStartedAt ?? Date.now();
    this.reconnectAttempt = 0;

    // Mute mic so no utterances reach a dead channel.
    if (this._micMode !== 'muted') this.setMicMode('muted');

    // Surface to the renderer-side store + main process.
    this.reportReconnectState('degraded', undefined);
    console.warn(`[realtime] connection lost (${reason}) — entering degraded mode`);
    this.scheduleReconnect();
  }

  private onConnectionRecovered(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.outageStartedAt = null;
    this.reconnectAttempt = 0;
    this.offlineNotificationSent = false;
    this.clearReconnectTimer();

    this.reportReconnectState('live', undefined);

    // Replay pending utterance, if any.
    if (this.pendingUtterance && this.dcReady) {
      const text = this.pendingUtterance;
      this.pendingUtterance = null;
      const okItem = this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        },
      });
      const okResp = this.send({ type: 'response.create' });
      if (!okItem || !okResp) {
        console.warn('[realtime] pending utterance replay dropped (DC not open)');
      } else {
        console.log('[realtime] replayed pending utterance after reconnect');
      }
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = nextDelay(this.reconnectAttempt);
    this.reportReconnectState('retrying', undefined);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.degraded || !this.autoReconnect) return;
    this.reconnectAttempt += 1;
    try {
      // Cold-reconnect: close any stale resources and rebuild from scratch.
      // We don't reuse the existing pc/dc — the browser's WebRTC stack can
      // get into wedge states that only `new RTCPeerConnection()` clears.
      this.tearDownPeerForReconnect();
      this._status = 'idle'; // bypass status guard in connect()
      await this.connect();
      // connect() flips status to 'connected' via onconnectionstatechange,
      // which in turn calls onConnectionRecovered().
    } catch (err) {
      // connect() calls this.close() on failure, which sets
      // autoReconnect=false. Re-enable so the retry loop keeps trying.
      this.autoReconnect = true;
      console.warn(`[realtime] reconnect attempt ${this.reconnectAttempt} failed`, err);
      this.reportReconnectState('degraded', err instanceof Error ? err.message : String(err));
      if (this.reconnectAttempt >= PERSISTENT_DEGRADED_AFTER_ATTEMPTS) {
        this.reportReconnectState('offline-persistent', undefined);
      }
      if (
        !this.offlineNotificationSent &&
        this.outageMs >= OFFLINE_NOTIFICATION_AFTER_MS
      ) {
        this.offlineNotificationSent = true;
        console.warn('[realtime] sustained outage — notification threshold crossed');
      }
      // Schedule the next retry with backoff.
      this.scheduleReconnect();
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private tearDownPeerForReconnect(): void {
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
    }
    if (this.remoteAudio && this.remoteAudio.parentNode) {
      try {
        this.remoteAudio.parentNode.removeChild(this.remoteAudio);
      } catch {
        /* ignore */
      }
    }
    this.dc = null;
    this.pc = null;
    this.micStream = null;
    this.remoteStream = null;
    this.remoteAudio = null;
  }

  private reportReconnectState(
    state: RealtimeReconnectStatePayload['state'],
    lastError: string | undefined,
  ): void {
    const bridge = window.director;
    if (!bridge?.realtimeRotation?.reportReconnectState) return;
    try {
      bridge.realtimeRotation.reportReconnectState({
        state,
        attempt: this.reconnectAttempt,
        lastError,
        outageMs: this.outageMs,
      });
    } catch (err) {
      console.warn('[realtime] failed to report reconnect state', err);
    }
  }

  /** Test-only escape hatch — drives the reconnect FSM without a real WebRTC. */
  _injectConnectionLossForTest(reason: string): void {
    this.onConnectionLost(reason);
  }

  /** Test-only — disable the auto-reconnect timer so tests don't hang. */
  _disableAutoReconnectForTest(): void {
    this.autoReconnect = false;
    this.clearReconnectTimer();
  }
}

// ─── § rotation + reconnect — internal contract notes ──────────────────────
//
// The renderer-side ownership boundaries for this file (W2 lane):
//  - `triggerRotation()` is the only public entry into the rotation path.
//  - `setPendingUtterance()` is the only public way for App.tsx to seed
//    the replay buffer.
//  - `isDegraded` / `outageMs` are read-only views the store can poll.
//
// Everything else is private to keep App.tsx free of WebRTC plumbing.
//
// References: docs/architecture.md §4 + §9, docs/remaining-phases.md §6.1
// and §6.2.

// Re-export the pure schedule helpers so call sites (App.tsx, tests, future
// telemetry surfaces) don't need a separate import.
export {
  nextDelay as reconnectNextDelay,
  PERSISTENT_DEGRADED_AFTER_ATTEMPTS as RECONNECT_PERSISTENT_AFTER,
  OFFLINE_NOTIFICATION_AFTER_MS as RECONNECT_OFFLINE_NOTIFY_AT_MS,
} from './reconnect-schedule.js';

export type { WorldStateBrief };
