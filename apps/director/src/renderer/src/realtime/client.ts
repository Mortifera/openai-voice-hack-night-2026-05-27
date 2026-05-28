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
import type { ToolCallRequest, ToolName } from '../../../shared/ipc.js';

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
        if (s === 'connected') this.setStatus('connected');
        else if (s === 'failed' || s === 'disconnected' || s === 'closed') {
          // Only downgrade if we were live; ignore transient "closed" before connect.
          if (this._status === 'connected') this.setStatus('closed');
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
}
