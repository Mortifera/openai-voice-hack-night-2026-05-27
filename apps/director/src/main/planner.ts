/**
 * gpt-5 planner service — main process only.
 *
 * Tier-2 of Director's 3-tier model. The Realtime layer (gpt-realtime-2)
 * handles the fast voice loop; when it needs deeper strategic thought, it
 * emits a `consult_director` function call, the tool-router forwards to
 * us, and this module calls OpenAI's Responses API with `gpt-5` +
 * `reasoning.effort: 'high'`. Reasoning-summary deltas stream back to the
 * strip renderer so the UI can show "thinking…" trail lines; the final
 * summary + decisions are returned to the tool-router so the Realtime
 * layer can narrate them.
 *
 * Spec: docs/contracts.md § 4.5 (`consult_director` tool def) + § 1
 * (process model). Side-store integration is stubbed until W3 ships
 * `main/side-store.ts`.
 */

import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannel } from '../shared/ipc.js';

const PLANNER_MODEL = 'gpt-5';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';

const DIRECTOR_PLANNER_INSTRUCTIONS = `
You are the Director's strategic planner. Your role is to think deeply about
the user's intent and produce a structured work breakdown, decision, or
clarification that will drive the rest of the system.

Constraints:
- Be terse. Never use filler phrases.
- Always end your output with a clear DECISIONS block:
  DECISIONS:
  - <single-sentence decisions, one per line>
- The "summary" the realtime layer will narrate aloud is 1-3 sentences.

You see the user's prompt plus the current World State (active agents,
recent decisions, Harness rules) and caller context (any structured args
passed by the Realtime layer).
`.trim();

export interface ConsultArgs {
  prompt: string;
  context?: Record<string, unknown>;
}

export interface ConsultResult {
  summary: string;
  decisions: string[];
  full_text: string;
}

interface ResponsesInputItem {
  role: 'system' | 'user';
  content: string;
}

interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  text?: string;
}

/**
 * Read the side-store-derived World State. W3 owns the side-store module;
 * until it ships we return an empty stub so the planner still compiles
 * and runs end-to-end.
 */
async function readWorldState(): Promise<Record<string, unknown>> {
  // TODO(side-store): swap for `await readSideStore()` once W3 ships it.
  return {
    active_agents: [],
    harness: [],
    recent_decisions: [],
    current_task: null,
  };
}

function buildInput(
  args: ConsultArgs,
  world: Record<string, unknown>,
): ResponsesInputItem[] {
  const user = [
    args.prompt,
    '',
    '## Current World State',
    '```json',
    JSON.stringify(world, null, 2),
    '```',
    '',
    '## Caller Context',
    '```json',
    JSON.stringify(args.context ?? {}, null, 2),
    '```',
  ].join('\n');

  return [
    { role: 'system', content: DIRECTOR_PLANNER_INSTRUCTIONS },
    { role: 'user', content: user },
  ];
}

function parseDecisions(text: string): string[] {
  const idx = text.lastIndexOf('DECISIONS:');
  if (idx < 0) return [];
  return text
    .slice(idx + 'DECISIONS:'.length)
    .split('\n')
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter((line) => line.length > 0)
    .slice(0, 10);
}

/**
 * Main entry point. Called from the tool-router on `consult_director` tool
 * calls. Streams `planner.reasoning.delta` IPC events to the strip
 * renderer if `mainWindow` is provided; returns the final synthesis once
 * the Responses stream terminates.
 */
export async function consultDirector(
  args: ConsultArgs,
  mainWindow?: BrowserWindow | null,
): Promise<ConsultResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('[planner] OPENAI_API_KEY missing in main process env');
  }

  const world = await readWorldState();
  const body = {
    model: PLANNER_MODEL,
    input: buildInput(args, world),
    reasoning: { effort: 'high', summary: 'auto' },
    stream: true,
    max_output_tokens: 4096,
  };

  const resp = await fetch(RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '<no body>');
    throw new Error(
      `[planner] Responses API ${resp.status}: ${errText.slice(0, 500)}`,
    );
  }
  if (!resp.body) {
    throw new Error('[planner] Responses API returned no body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let reasoningSummary = '';
  let finalText = '';

  const emit = (channel: string, payload: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send(channel, payload);
      } catch {
        /* renderer gone — ignore */
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by a blank line. Drain complete events from
    // the buffer; leave any trailing partial event in place.
    let sepIdx: number;
    while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      const dataLines = rawEvent
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice('data: '.length));

      if (dataLines.length === 0) continue;
      const dataStr = dataLines.join('\n');
      if (dataStr === '[DONE]') continue;

      let event: ResponsesStreamEvent;
      try {
        event = JSON.parse(dataStr);
      } catch {
        continue;
      }

      // Be permissive on the reasoning event name — OpenAI has used both
      // response.reasoning_summary_text.delta and response.reasoning_text.delta
      // across model versions. If we ever see neither + nothing in output,
      // diagnostic log below will surface it.
      if (
        (event.type === 'response.reasoning_summary_text.delta' ||
          event.type === 'response.reasoning_text.delta' ||
          event.type === 'response.reasoning.delta') &&
        typeof event.delta === 'string'
      ) {
        reasoningSummary += event.delta;
        emit(IpcChannel.PlannerReasoningDelta, { delta: event.delta });
      } else if (
        event.type === 'response.output_text.delta' &&
        typeof event.delta === 'string'
      ) {
        finalText += event.delta;
      } else if (event.type === 'response.failed' || event.type === 'error') {
        // Surface API errors to the caller so we don't silently return empty.
        const errMsg =
          (event as { error?: { message?: string } }).error?.message ??
          (event as { message?: string }).message ??
          'unknown planner error';
        console.error('[planner] stream error event:', errMsg, event);
        throw new Error(`[planner] stream error: ${errMsg}`);
      }
      // Other event types (response.created, response.completed, …) are
      // informational; we don't need them for the synthesis.
    }
  }

  const decisions = parseDecisions(finalText);
  const summary = reasoningSummary.trim() || finalText.trim().slice(0, 280);

  // Diagnostic: if we got nothing at all, the SSE event types may have
  // shifted on the API side. Log so we can spot it fast.
  if (!summary && !finalText) {
    console.warn(
      '[planner] stream produced no usable text — check Responses API event names',
    );
  }

  return { summary, decisions, full_text: finalText };
}

/**
 * Dev-only IPC handler so the renderer (or a future debug surface) can
 * invoke the planner directly without going through Realtime.
 */
export function registerPlannerDevIpc(mainWindow: BrowserWindow | null): void {
  ipcMain.handle(
    IpcChannel.PlannerConsult,
    async (
      _evt,
      args: ConsultArgs,
    ): Promise<{ ok: true; result: ConsultResult } | { ok: false; error: string }> => {
      try {
        const result = await consultDirector(args, mainWindow);
        return { ok: true, result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );
}
