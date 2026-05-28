/**
 * Tool router — main-process dispatch for the four Realtime tools.
 *
 * Director's `gpt-realtime-2` session exposes exactly four tools:
 *   - render_canvas        → main pushes a Canvas window render
 *   - dispatch_agent_mock  → main records an agent in the renderer store
 *                            and (on first call) kicks the Mixtape sim
 *   - ask_user             → main asks the strip renderer, waits for answer
 *   - update_harness       → main appends the rule + flashes harness card
 *
 * The router lives in the main process so all side effects (canvas window,
 * persistence later) stay co-located with the OS-level surfaces. It pushes
 * mutations into the renderer's canonical Zustand store via `state.patch`
 * IPC events; the renderer's `state/ipcSync.ts` applies them.
 *
 * Contract:
 *   - `routeToolCall(req)` returns `Promise<ToolCallResponse>`.
 *   - On unknown tool names, returns `{ok:false, error:'unknown_tool'}` —
 *     never throws.
 *   - `ask_user` resolves with `{answer:'timeout'}` after `ASK_TIMEOUT_MS`
 *     if the renderer never replies.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { CanvasIpcChannel, type CanvasRenderPayload } from '../shared/canvas-ipc.js';
import {
  IpcChannel,
  type AskAnswerPayload,
  type AskShowPayload,
  type CanvasRenderBroadcastPayload,
  type StatePatchPayload,
  type ToolCallRequest,
  type ToolCallResponse,
} from '../shared/ipc.js';
import { renderCanvas } from './canvas.js';
import { consultDirector, type ConsultArgs } from './planner.js';

const ASK_TIMEOUT_MS = 60_000;

// ─── Identity table (Pass 4) ─────────────────────────────────────────────

interface AgentIdentity {
  id: 'maya' | 'jin' | 'cleo' | 'wren';
  accentColor: `#${string}`;
}

const IDENTITY: Record<string, AgentIdentity> = {
  maya: { id: 'maya', accentColor: '#E07856' },
  jin: { id: 'jin', accentColor: '#4A9E9C' },
  cleo: { id: 'cleo', accentColor: '#C99550' },
  wren: { id: 'wren', accentColor: '#9670A0' },
};

function resolveIdentity(rawName: string): AgentIdentity {
  const slug = rawName.trim().toLowerCase();
  if (slug in IDENTITY) return IDENTITY[slug as keyof typeof IDENTITY]!;
  return { id: slug as AgentIdentity['id'], accentColor: '#9AA0A6' };
}

function capitalizeRole(role: string): 'Frontend' | 'Backend' | 'Data' | 'Design' | string {
  const r = role.toLowerCase();
  if (r === 'frontend') return 'Frontend';
  if (r === 'backend') return 'Backend';
  if (r === 'data') return 'Data';
  if (r === 'design') return 'Design';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

// ─── Wiring state ────────────────────────────────────────────────────────

interface RouterContext {
  /** Strip window — receives state.patch + ask.show events. */
  stripWindow: BrowserWindow | null;
  /** Counter mirrors the renderer's harness slice for ack convenience. */
  harnessCount: number;
  /** Tracks pending ask_user prompts → their resolve fns. */
  pendingAsks: Map<string, (answer: string) => void>;
  /** True after the first dispatch_agent_mock call — gates sim start. */
  simKicked: boolean;
}

const ctx: RouterContext = {
  stripWindow: null,
  harnessCount: 0,
  pendingAsks: new Map(),
  simKicked: false,
};

export function setToolRouterStripWindow(window: BrowserWindow | null): void {
  ctx.stripWindow = window;
}

/**
 * Reset main-side counters. Call from `app.whenReady` if the session is
 * being recycled in dev.
 */
export function resetToolRouter(): void {
  ctx.harnessCount = 0;
  ctx.simKicked = false;
  ctx.pendingAsks.clear();
}

function sendStripPatch(domain: StatePatchPayload['domain'], patch: unknown): void {
  const w = ctx.stripWindow;
  if (!w || w.isDestroyed()) {
    console.warn('[tool-router] no strip window — dropping state.patch', { domain });
    return;
  }
  const payload: StatePatchPayload = {
    domain,
    patch,
    source: 'orchestrator',
    at: Date.now(),
  };
  w.webContents.send(IpcChannel.StatePatch, payload);
}

// ─── Tool handlers ───────────────────────────────────────────────────────

interface RenderCanvasArgs {
  component: string;
  props?: Record<string, unknown>;
  component_id?: string;
}

interface DispatchAgentMockArgs {
  name: string;
  role: string;
  task: string;
}

interface AskUserArgs {
  question: string;
  options?: string[];
}

interface UpdateHarnessArgs {
  rule: string;
  why: string;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

async function handleRenderCanvas(
  req: ToolCallRequest,
  args: RenderCanvasArgs,
): Promise<ToolCallResponse> {
  const startedAt = Date.now();
  const component_id = args.component_id ?? req.callId;
  const props = (args.props && isObject(args.props) ? args.props : {}) as Record<
    string,
    unknown
  >;

  const showPayload: CanvasRenderPayload = {
    component: args.component,
    props,
    component_id,
    call_id: req.callId,
  };
  // Drive the actual Canvas BrowserWindow.
  renderCanvas(showPayload);

  // Re-broadcast on the main bus for any other observer (logging, state
  // mirror) — the wire string matches `CanvasIpcChannel.Render`.
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    const broadcast: CanvasRenderBroadcastPayload = {
      component: args.component,
      props,
      component_id,
      call_id: req.callId,
    };
    try {
      w.webContents.send(IpcChannel.CanvasRender, broadcast);
    } catch {
      /* ignore */
    }
  }

  return {
    ok: true,
    callId: req.callId,
    output: { component_id },
    latencyMs: Date.now() - startedAt,
  };
}

async function handleDispatchAgentMock(
  req: ToolCallRequest,
  args: DispatchAgentMockArgs,
): Promise<ToolCallResponse> {
  const startedAt = Date.now();
  const identity = resolveIdentity(args.name);
  const role = capitalizeRole(args.role);
  const agentId = identity.id;

  const agent = {
    id: agentId,
    name: args.name.trim() || agentId,
    role,
    accentColor: identity.accentColor,
    status: 'working' as const,
    currentTask: args.task,
    taskTrail: [args.task],
    recentFiles: [] as string[],
    blocker: null,
    worktreePath: `~/.director/worktrees/${agentId}`,
    codexThreadId: null,
    dispatchedAt: Date.now(),
    finishedAt: null,
  };

  sendStripPatch('agents', { action: 'addAgent', agent });

  // First dispatch kicks the sim in canonical mode. The sim runs trail
  // updates, the T+1:45 Jin block, and the staggered completions.
  if (!ctx.simKicked) {
    ctx.simKicked = true;
    sendStripPatch('strip', {
      action: 'startSim',
      compressed: false,
      seedAgents: false,
    });
  }

  return {
    ok: true,
    callId: req.callId,
    output: { agent_id: agentId },
    latencyMs: Date.now() - startedAt,
  };
}

function makeAskId(): string {
  return `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function handleAskUser(
  req: ToolCallRequest,
  args: AskUserArgs,
): Promise<ToolCallResponse> {
  const startedAt = Date.now();
  const askId = makeAskId();
  const w = ctx.stripWindow;
  const payload: AskShowPayload = {
    ask_id: askId,
    question: args.question,
    options: args.options,
    call_id: req.callId,
  };

  const answer = await new Promise<string>((resolve) => {
    let settled = false;
    const settle = (val: string): void => {
      if (settled) return;
      settled = true;
      ctx.pendingAsks.delete(askId);
      clearTimeout(timer);
      resolve(val);
    };
    ctx.pendingAsks.set(askId, settle);
    const timer = setTimeout(() => settle('timeout'), ASK_TIMEOUT_MS);
    if (!w || w.isDestroyed()) {
      console.warn('[tool-router] no strip window — ask_user timing out fast', payload);
      settle('timeout');
      return;
    }
    w.webContents.send(IpcChannel.AskShow, payload);
  });

  return {
    ok: true,
    callId: req.callId,
    output: { answer },
    latencyMs: Date.now() - startedAt,
  };
}

async function handleConsultDirector(
  req: ToolCallRequest,
  args: ConsultArgs,
): Promise<ToolCallResponse> {
  const startedAt = Date.now();
  if (!args || typeof args.prompt !== 'string' || args.prompt.length === 0) {
    return {
      ok: false,
      callId: req.callId,
      error: 'consult_director: missing or empty `prompt`',
      latencyMs: Date.now() - startedAt,
    };
  }
  try {
    const result = await consultDirector(args, ctx.stripWindow);
    return {
      ok: true,
      callId: req.callId,
      output: result,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      callId: req.callId,
      error: message,
      latencyMs: Date.now() - startedAt,
    };
  }
}

async function handleUpdateHarness(
  req: ToolCallRequest,
  args: UpdateHarnessArgs,
): Promise<ToolCallResponse> {
  const startedAt = Date.now();
  ctx.harnessCount += 1;
  const rule = {
    id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    rule: args.rule,
    why: args.why,
    timestamp: Date.now(),
    scope: 'project' as const,
    source: 'user-utterance' as const,
  };
  sendStripPatch('harness', { action: 'addHarnessRule', rule });

  // Flash the harness_rule_save Canvas card (1.2s).
  const flashId = `harness-flash-${rule.id}`;
  const flashPayload: CanvasRenderPayload = {
    component: 'harness_rule_save',
    props: { rule: args.rule, why: args.why, harness_count: ctx.harnessCount },
    component_id: flashId,
    call_id: req.callId,
    autoDismissMs: 1200,
  };
  renderCanvas(flashPayload);

  return {
    ok: true,
    callId: req.callId,
    output: { harness_count: ctx.harnessCount },
    latencyMs: Date.now() - startedAt,
  };
}

// ─── Public router ───────────────────────────────────────────────────────

export async function routeToolCall(req: ToolCallRequest): Promise<ToolCallResponse> {
  try {
    const args = (isObject(req.args) ? req.args : {}) as Record<string, unknown>;
    switch (req.name) {
      case 'render_canvas':
        return await handleRenderCanvas(req, args as unknown as RenderCanvasArgs);
      case 'dispatch_agent_mock':
        return await handleDispatchAgentMock(
          req,
          args as unknown as DispatchAgentMockArgs,
        );
      case 'ask_user':
        return await handleAskUser(req, args as unknown as AskUserArgs);
      case 'update_harness':
        return await handleUpdateHarness(req, args as unknown as UpdateHarnessArgs);
      case 'consult_director':
        return await handleConsultDirector(req, args as unknown as ConsultArgs);
      default:
        console.warn('[tool-router] unknown tool', req.name);
        return {
          ok: false,
          callId: req.callId,
          error: `unknown_tool:${String(req.name)}`,
          latencyMs: 0,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[tool-router] handler threw', req.name, err);
    return { ok: false, callId: req.callId, error: message, latencyMs: 0 };
  }
}

// ─── IPC wiring ──────────────────────────────────────────────────────────

/**
 * Wire the router onto IPC. Call once from `main/index.ts` after the
 * strip window is created.
 */
export function registerToolRouterIpc(stripWindow: BrowserWindow): void {
  setToolRouterStripWindow(stripWindow);

  // `tool.call` is the canonical channel the realtime layer invokes. Main
  // handles it here; the response shape matches `ToolCallResponse`.
  // NB: `main/index.ts` may have an older handler already registered —
  // calling `handle` again would throw. We use `handleOnce`-style by first
  // removing whatever's wired.
  try {
    ipcMain.removeHandler(IpcChannel.ToolCall);
  } catch {
    /* no existing handler */
  }
  ipcMain.handle(
    IpcChannel.ToolCall,
    async (_evt, req: ToolCallRequest): Promise<ToolCallResponse> => {
      console.log(`[tool-router] tool.call name=${req.name} callId=${req.callId}`);
      const result = await routeToolCall(req);
      return result;
    },
  );

  // `ask.answer` — the strip renderer sends user resolutions back here.
  ipcMain.on(IpcChannel.AskAnswer, (_evt, payload: AskAnswerPayload) => {
    const resolver = ctx.pendingAsks.get(payload.ask_id);
    if (!resolver) {
      console.warn('[tool-router] ask.answer for unknown ask_id', payload.ask_id);
      return;
    }
    resolver(payload.answer);
  });

  // `canvas.user_response` — keep harness-flash + canvas-response flow
  // consistent: any canvas user response auto-acks here for telemetry.
  ipcMain.on(CanvasIpcChannel.UserResponse, (_evt, payload) => {
    console.log('[tool-router] canvas.user_response', payload);
  });
}
