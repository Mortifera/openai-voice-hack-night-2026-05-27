# `gpt-realtime-2` — Research Notes for Director

Compiled 2026-05-27 from `developers.openai.com`, the original `gpt-realtime` launch post, the Realtime VAD / WebRTC / Conversations guides, and Microsoft Foundry's parallel docs for the same model. The Foundry docs are the most explicit source for the **response-phase** machinery because they ship the schema.

---

## 0. TL;DR

`gpt-realtime-2` is a speech-to-speech model with built-in reasoning. Each model turn can emit multiple output items, and each item carries a `phase` of either `commentary` (preamble) or `final_answer` (post-thinking answer). Reasoning is configurable via `reasoning.effort` (`minimal | low | medium | high | xhigh`), context is 128k (256k on Foundry), audio is PCM-16 @ 24 kHz (or G.711 μ-law / A-law for telephony), and connection is via WebRTC, WebSocket, or SIP, with a short-lived client secret minted from a server. **The server cannot push a `response.create` over the wire — only the client connection can — but that client can be *your own backend* on a WebSocket connection, which gives Director the proactive-escalation path it needs.**

---

## 1. Preamble

### What it is
Preambles are short spoken updates the model emits *before* extended reasoning or a tool call to keep the conversation feeling responsive. They are not chain-of-thought; they describe the *action* ("I'll check that order now"), not the reasoning. In the wire format they show up as an assistant output item with `phase: "commentary"`, distinct from `phase: "final_answer"`.

### How you enable / steer it
Preambles are a *behavior* of the model, not a boolean flag. You shape them by:
- Writing instructions that tell the model when to use one (multi-step tasks, tool calls, record lookups, escalations).
- Telling it the *style* (one short sentence, vary wording, no "let me think…" filler).
- Persisting prior `commentary` items across turns when feeding history back, so the model knows what it has already said.

OpenAI's prompting guide gives a reusable section:

```
## Reasoning
- For direct answers, simple lookups, and short confirmations, respond quickly and do not reason.
- For multi-step tasks, tool decisions, troubleshooting, or escalation, reason before acting.
- Do not perform extended reasoning when the user's audio is unclear; ask for clarification instead.
```

### When the model speaks the preamble
**Before** the tool call and **before** the heavy reasoning. The preamble item streams (`response.output_item.added` + `response.audio.delta` chunks) to the wire and plays to the user, *then* the model performs reasoning / emits the `function_call` item, *then* you return the function output, *then* the `final_answer` item streams. The DataCamp piece adds that with parallel tool calls the model can narrate while multiple functions run concurrently.

### → Implication for Director
Preambles solve the worst UX problem in Director: the gap between "Director, refactor the auth layer" and the first sound from Codex. The voice layer (`gpt-realtime-2`) should be prompted hard to *always* emit a preamble when it delegates to the `gpt-5.5` orchestrator, so the user hears "On it — kicking off the refactor agent" inside ~300ms. We also need to **tag those `commentary` items in our state store** so we never replay them as if they were the answer, and we should consider *not* showing them in the chat transcript pane (they're ambient, not durable).

---

## 2. Thinking / Reasoning

### What it is
`gpt-realtime-2` is a reasoning model that "thinks before it speaks." Reasoning tokens are billed but **not surfaced** to the client; you only see the resulting `final_answer` item.

### Configuration
Field: `reasoning.effort` on the session (or per `response.create`).
Values: `minimal`, `low`, `medium`, `high`, `xhigh`. Default recommended: `low`.

| Level | Suggested use |
|---|---|
| `minimal` | Smart-home commands, timer, "what time is it" |
| `low` | Customer support, order lookup, policy questions |
| `medium` | Technical support, diagnostics, routing |
| `high` | High-precision workflows, escalation decisions |
| `xhigh` | Complex planning, critical triage, tool orchestration |

### Latency behavior
Higher effort = noticeably more latency before the `final_answer` item begins streaming. Audio output **does** wait for thinking to finish for that item — which is why preambles exist. Critically, **if the user interrupts mid-thinking, the chain of thought is discarded and a new turn begins** (Foundry doc, explicit).

### → Implication for Director
For Director's reflex layer (voice → router decisions), we want `reasoning.effort: "minimal"` or `"low"` — the model is just deciding whether to chat, ask a clarifying question, or hand off. The *real* thinking lives in `gpt-5.5` (orchestrator) and the Codex sub-agents. We pay reasoning tokens twice if we set `high` here, and we pay them in the most expensive tier (audio output is $64/M). Reserve `medium`/`high` for the orchestrator. Also: because interruption nukes the in-progress reasoning, Director must be careful that ambient "agent X finished" injections (see §8) don't accidentally count as interruption.

---

## 3. Tool / Function Calling

### Schema
Tools are declared in `session.tools` (or per-response). Standard JSON-Schema-flavored shape:

```json
"tools": [{
  "type": "function",
  "name": "generate_horoscope",
  "description": "Give today's horoscope for an astrological sign.",
  "parameters": {
    "type": "object",
    "properties": { "sign": { "type": "string", "enum": ["Aries","Taurus"] } },
    "required": ["sign"]
  }
}]
```

`tool_choice` accepts `"auto" | "none" | "required" | {"type":"function","name":"..."}`. MCP remote servers are supported as a tool type alongside `function` — you can point the session at an MCP endpoint and the model picks tools off it directly.

### Execution flow
1. Client sends `session.update` with tools (or includes them on `response.create`).
2. Model emits a `response.function_call_arguments.delta` stream (you can render "calling X…" in UI) followed by `response.function_call_arguments.done`.
3. `response.done` arrives with `output[i].type === "function_call"`, plus `name`, `arguments` (JSON string), and `call_id`.
4. **You** execute the function client/server-side. There is no server-side execution unless you used MCP.
5. Send `conversation.item.create` with `item.type: "function_call_output"`, the matching `call_id`, and `output` as a JSON string.
6. Send `response.create` to make the model speak the result.

### Parallel + async
`gpt-realtime` (and `-2`) supports **parallel tool calls** and **asynchronous function calling** — long-running calls don't block conversational flow, and the model can keep narrating while results pend. The model also narrates between parallel calls if you let it.

### → Implication for Director
Codex sub-agents are async by nature (a refactor takes 30s–10min). We model each Codex job as a tool call that returns *immediately* with `{ "job_id": "...", "status": "started" }`, then we feed completion back later via `conversation.item.create` with a `function_call_output` item (or as a synthetic user/system message, see §8) when the job actually finishes. This lets `gpt-realtime-2` keep talking to the user while Codex runs — without the realtime model itself blocking on Codex. Also: define Director's high-level tools (e.g. `dispatch_codex`, `read_workspace`, `show_diff`, `inject_genui`) on the realtime session, and let it offload everything heavy to `gpt-5.5` via a single `delegate_to_orchestrator` tool.

---

## 4. Barge-in / Interruption

### Two VAD modes
- **`server_vad`** — silence-based. Fields: `threshold` (0–1), `prefix_padding_ms`, `silence_duration_ms`, `create_response` (auto-trigger response on stop), `interrupt_response` (auto-cancel in-flight response on speech start).
- **`semantic_vad`** — turn-detection model that decides when the user is *semantically* done. Field: `eagerness` (`low | medium | high | auto`; default `auto` ≈ medium). Max timeouts: low=8s, medium=4s, high=2s. Higher latency than `server_vad`, more natural turn-taking.

### Events that fire on barge-in
- `input_audio_buffer.speech_started` — VAD detected user audio. If `interrupt_response: true`, the current response is canceled server-side. Otherwise the client must send `response.cancel`.
- `input_audio_buffer.speech_stopped` — turn boundary.
- `input_audio_buffer.committed` — buffered audio committed for processing.
- If a model response is in flight when interruption fires, you'll see `response.done` early with truncation, and (if applicable) `conversation.item.truncated` to indicate the assistant item was cut.

### Interruption + reasoning
Per Foundry: **interrupting during thinking discards the in-progress chain of thought** and starts a new turn. The preamble may have already played; the `final_answer` will not.

### → Implication for Director
Use `semantic_vad` with `eagerness: "medium"` for the conversational layer — Director is a thinking assistant, not a drive-through speaker, and the user will pause mid-thought. Set `interrupt_response: true` so the model shuts up cleanly when the user starts talking. Critically, **playback of model audio must be visually + audibly cancellable on the client side** — when `response.cancel` fires we must stop the local audio buffer immediately or the user hears two seconds of stale speech. Also: do *not* treat agent-completion injections from Codex as interruptions — they go in via `conversation.item.create`, never via the audio buffer.

---

## 5. Session Configuration

Canonical shape (current GA, post-beta-header removal):

```json
{
  "type": "session.update",
  "session": {
    "type": "realtime",
    "model": "gpt-realtime-2",
    "output_modalities": ["audio"],
    "instructions": "You are Director, a voice-orchestrated coding...",
    "audio": {
      "input":  { "format": {"type":"audio/pcm","rate":24000},
                  "turn_detection": {"type":"semantic_vad","eagerness":"medium","interrupt_response":true} },
      "output": { "format": {"type":"audio/pcm"}, "voice": "marin", "speed": 1.0 }
    },
    "tools": [ /* function + mcp tools */ ],
    "tool_choice": "auto",
    "reasoning": { "effort": "low" },
    "max_response_output_tokens": 4096,
    "include": ["item.input_audio_transcription.logprobs"]
  }
}
```

Notes:
- `voice` and `model` are immutable **after** the first audio response. Set them right at session start.
- `output_modalities` of `["audio"]` still produces a streamed transcript via `response.audio_transcript.delta` — you do *not* need to add `"text"`.
- Max session duration is 60 minutes (hard cap). You must rotate sessions.
- Available voices (Realtime-exclusive): `marin`, `cedar`. Eight legacy voices (alloy, ash, ballad, coral, echo, sage, shimmer, verse) also supported with quality updates.

### → Implication for Director
Hard-code `voice: "marin"` (or `cedar`) at session start so we don't get a "voice cannot change" error. Build a **session-rotation strategy** for the 60-minute cap — we need to be able to spin up a fresh `gpt-realtime-2` session and replay the last N conversation items into it without the user noticing (a small audio "yawn" + silent context re-injection on rotation).

---

## 6. Connection Model

### Three transports
- **WebRTC** — best for browser/desktop with local mic. ~lowest latency, jitter-resistant, audio handled natively.
- **WebSocket** — best for server-mediated audio (telephony, in-process orchestration). Director's Electron app could use either.
- **SIP** — for direct phone-network attach. Not relevant for Director.

### Ephemeral token flow
1. Electron renderer → Director backend: "give me a realtime session."
2. Backend → `POST https://api.openai.com/v1/realtime/client_secrets` with the full session config in the body and `Authorization: Bearer <OPENAI_API_KEY>`.
3. Backend returns `{ client_secret: { value: "...", expires_at: ... } }` to the renderer.
4. Renderer creates `RTCPeerConnection`, attaches mic track + a data channel named `"oai-events"`, generates an SDP offer, and POSTs it to `https://api.openai.com/v1/realtime/calls` with the ephemeral key.
5. OpenAI returns SDP answer; the data channel becomes the JSON event bus.

Minimal Node snippet:

```js
const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
             "Content-Type": "application/json" },
  body: JSON.stringify({ session: { type: "realtime", model: "gpt-realtime-2",
                                    audio: { output: { voice: "marin" } } } })
});
const { client_secret } = await res.json();
```

### → Implication for Director
The Electron renderer should use **WebRTC** for the mic-side voice channel — better jitter handling, native echo cancellation, lower latency than wiring raw PCM over a WebSocket. *But* the Director **main process** should *also* hold a **WebSocket** session (or use the same data channel) so it can push `conversation.item.create` events from the orchestrator into the conversation — see §8. So architecturally: renderer = WebRTC for audio, main process = data-channel proxy for context injection. The ephemeral token endpoint runs in the Electron main process (we don't want `OPENAI_API_KEY` in the renderer).

---

## 7. Audio Formats & Latency

- **Input formats:** `audio/pcm` (16-bit, mono, **24 kHz** by default), `audio/pcmu` (G.711 μ-law, 8 kHz), `audio/pcma` (G.711 A-law, 8 kHz). Base64-encoded on the WebSocket path; raw RTP on WebRTC.
- **Output formats:** same options. Default 24 kHz PCM. Set via `session.audio.output.format`.
- **Buffer events:** `input_audio_buffer.append` (base64 chunks, WebSocket path), `input_audio_buffer.commit`, `input_audio_buffer.clear`. WebRTC handles append/commit automatically from the audio track.
- **Latency:** OpenAI doesn't quote a single number, but the launch material targets sub-second response onset for `low` reasoning + `server_vad`. Real-world WebRTC measurements from the community land at **~300–800 ms** from end-of-user-speech to first audio frame at `low` effort. Higher `reasoning.effort` adds seconds; preambles mask it.

### → Implication for Director
Stick with PCM 24 kHz both ways for best fidelity (we're not on a phone). Budget our perceived latency at ~500 ms for reflex turns and ~2–5 s for delegation turns — and make sure every delegation turn fires a preamble so the user never hears that 5-second gap as dead air.

---

## 8. Server-Initiated Responses (proactive escalation)

**There is no server-push of `response.create`.** Only the *client side of the realtime connection* can send `response.create`. But — crucially — the connection's "client" is just whatever process holds the WebSocket / data channel. Director's main process *is* that client.

So the proactive flow is:
1. Codex sub-agent (running outside the realtime session) finishes.
2. Director main process sends `conversation.item.create` over the data channel with a synthetic item — typically a `function_call_output` (if we modeled the dispatch as a tool call, see §3) or a `message` with `role: "system"` and content like `"[agent:refactor-auth] completed. Files changed: 4. Tests: 3 added, all pass."`.
3. Director main process sends `response.create` with `instructions: "The user is idle. Briefly announce the agent result in one sentence."` and optionally `conversation: "none"` if we want it out-of-band (won't be added to the running conversation state).

Out-of-band responses are also useful for parallel summarization or background analysis without polluting the main conversation history. They're identified via `response.metadata`.

### → Implication for Director
**This is the load-bearing finding for our architecture.** Director's "the model speaks unprompted when an agent finishes" feature works *because* our main process is a peer on the data channel. We model every Codex dispatch as: (a) tool call → immediate `{job_id, status:'started'}` return, (b) when the job completes, our orchestrator pushes a `conversation.item.create` + `response.create` pair into the same realtime session. We should add a `metadata.kind: "proactive_announcement"` tag to all server-initiated responses so the renderer can style them distinctly (e.g. soft chime + GenUI card).

---

## 9. State & Context Management

- **Session lifetime:** 60 minutes max, hard cap. Rotate sessions and replay context.
- **Conversation item types:** `message` (user/assistant/system, with `input_text | input_audio | input_image | output_text | output_audio` content blocks), `function_call`, `function_call_output`.
- **Manual insertion:** `conversation.item.create` with full payload. Can reference an existing item by `id`. `conversation.item.delete` and `conversation.item.truncate` available for editing history (the latter for trimming mid-response audio when the user barges in).
- **`include` field:** `["item.input_audio_transcription.logprobs"]` and similar to get richer transcripts.
- **Out-of-band responses:** `response.create` with `conversation: "none"` and an explicit `input: [...]` — runs the model on a custom context without affecting the live conversation. Useful for sidecar tasks (summarization, intent classification, redaction).

### → Implication for Director
For Director's "agent X reported done" pattern, **inject as a `system` message in the conversation** (clean, durable, model treats as authoritative) — not as a fake user turn. For session rotation, persist the last ~20 items (skip raw audio blobs, keep transcripts) in our own store and replay them as `conversation.item.create` on the new session before unmuting the mic. For the GenUI prompts, use **out-of-band responses** to ask the realtime model to emit structured layout decisions without speaking — saves audio output tokens.

---

## 10. Pricing

Per `developers.openai.com/api/docs/models/gpt-realtime-2`, per 1M tokens:

| Modality | Input | Cached input | Output |
|---|---|---|---|
| Text | $4.00 | $0.40 | $24.00 |
| Audio | $32.00 | $0.40 | $64.00 |
| Image | $5.00 | $0.50 | — |

- Context window: 128k (Foundry doc says 256k on Azure preview — keep an eye on parity).
- Max output tokens per response: 32,000.
- 20% cheaper than `gpt-realtime` preview for audio.
- Reasoning tokens are billed as output tokens.

### → Implication for Director
Audio in/out dominates cost (~$0.10/min if both sides talk continuously at typical density). Two big levers: (1) **prompt caching** — keep `instructions` and tool definitions stable across sessions so the $0.40 cached-input price kicks in; (2) **avoid speaking the obvious** — instruct the model to give terse confirmations and use GenUI for anything list-shaped. For background tasks like summarization and classification, **route to text-mode `gpt-5.5` not to realtime audio output** — text out is $24/M vs audio out $64/M.

---

## 11. Surprises & Non-obvious findings vs the original Realtime model

1. **`phase` on assistant items is the actual mechanism behind "preamble + thinking"** — not a flag, but a structural property of each output item. You must persist it across turns or future preambles get misclassified as final answers.
2. **Interruption during thinking nukes the chain of thought.** No resume. Important: don't trigger interruption unless you mean it.
3. **`reasoning.effort: "xhigh"` exists** and is meaningfully slower; it's only worth it for critical triage.
4. **Out-of-band responses (`conversation: "none"`)** turn the realtime session into a general-purpose model runner — you can run summarization or intent classification on the same socket, identified by `response.metadata`.
5. **MCP servers are first-class tool types** alongside `function` — no glue code needed to expose a remote MCP to the voice model. Could let us hand Director's filesystem/git access to the realtime layer directly, skipping `gpt-5.5` for trivial reads.
6. **Voice and model are immutable after first audio output.** Plan accordingly at session start.
7. **`gpt-realtime-2` accepts image input** (text + audio + images in, audio + text out). Screenshots from the Electron overlay can go directly to the voice model — no separate vision call.
8. **Connection event channel is named `"oai-events"`** on WebRTC. Hard-coded; don't bikeshed it.
9. **The model can switch languages mid-conversation** more reliably than the preview — relevant if Director ever ships multilingual.
10. **Instruction following is *stricter*** than the preview — Foundry warns that narrow wording in system prompts ("order ID" ≠ "confirmation code") can cause matches to fail. Write Director's instructions broadly.

---

## Decisions we need to make

1. **WebRTC vs WebSocket for the renderer ↔ OpenAI link.** Recommended: WebRTC for audio. But: does the Electron main process get its *own* socket for context injection, or does it relay through the renderer's data channel?
2. **Reasoning effort defaults.** Probably `low` for reflex turns, but should "delegate to orchestrator" turns bump to `medium` for better routing decisions, or do we always offload that reasoning to `gpt-5.5`?
3. **VAD mode.** `semantic_vad` with `eagerness: "medium"` feels right for an assistant-style flow, but `server_vad` is lower latency. Pick one and stick to it — switching mid-session is messy.
4. **How does an agent-completion event reach the user?** Pure audio announcement, audio + GenUI card, GenUI card only, or user-configurable per agent? This decides whether we hit `response.create` or just `conversation.item.create`.
5. **Session rotation strategy at the 60-minute cap.** Hot handoff (replay context silently) vs cold "I lost the thread, where were we?" Almost certainly hot, but how many items do we replay and do we collapse them into a summary first?
6. **Do we expose MCP tools directly to `gpt-realtime-2`** for cheap reads (file open, git status), or do all tool calls have to go through `gpt-5.5` for safety/policy?
7. **Voice choice — `marin` or `cedar`?** Pick one for the demo and ship.
8. **GenUI rendering — out-of-band response vs in-band tool call?** Out-of-band is cleaner (doesn't pollute audio conversation history) but adds an extra round trip.
9. **How do we tag and style `commentary` items in the transcript UI?** Hide them entirely, show them faded, or treat them as first-class? Affects how "transparent" Director feels.
10. **Prompt caching strategy.** Are `instructions` + `tools` fully stable, or do we vary them per task? If stable, we lock in the 10x discount on input tokens — worth designing toward.
