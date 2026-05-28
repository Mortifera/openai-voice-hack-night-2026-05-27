#!/usr/bin/env tsx
/**
 * Headless Mixtape dogfood — proves the codex-pool can orchestrate real
 * Codex subprocesses to completion without booting the Electron app.
 *
 * Flow:
 *   1. Verify target repo (examples/mixtape) is clean and on its default branch.
 *   2. Parallel-dispatch Cleo (lib/store) + Jin (api/mixtape/[id]/route) via
 *      dispatchAgentCore — same codepath the Director main process uses.
 *   3. Wait for both agents to finish (per-agent 5min timeout).
 *      Inside each agent_finished handler, synchronously capture the
 *      worktree's HEAD SHA via execFileSync — must run before the pool's
 *      async cleanup() removes the worktree + branch.
 *   4. Cherry-pick both SHAs onto a fresh `director/dogfood-<id>` branch
 *      on the target repo. Conflict = abort.
 *   5. mixtape typecheck + build must pass.
 *   6. `next start` in background; curl POST, GET, GET-404 against the route.
 *   7. Clean up — kill server, prune branch, restore original branch.
 *
 * Run: pnpm --filter director dogfood:mixtape
 */

import { config as loadDotenv } from 'dotenv';
import {
  execFileSync,
  spawn,
  type ChildProcess,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dispatchAgentCore,
  abortAgentCore,
  waitForAgentCore,
  type CodexEvent,
  type DispatchAck,
  type DispatchAgentRequest,
} from '../src/main/codex-pool-core.js';

// ─── Bootstrap paths + env ────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
const TARGET_REPO = resolve(REPO_ROOT, 'examples', 'mixtape');

loadDotenv({ path: resolve(REPO_ROOT, '.env') });
loadDotenv({ path: resolve(APP_DIR, '.env') });

if (!process.env.OPENAI_API_KEY) {
  console.error(
    '[dogfood] OPENAI_API_KEY missing — set it in repo-root .env or apps/director/.env',
  );
  process.exit(1);
}

// ─── Logging ──────────────────────────────────────────────────────────

const SESSION_ID = `dogfood-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
const t0 = Date.now();
function ts(): string {
  const sec = ((Date.now() - t0) / 1000).toFixed(1).padStart(5, ' ');
  return `[+${sec}s]`;
}
function log(...args: unknown[]): void {
  console.log(ts(), ...args);
}
function logErr(...args: unknown[]): void {
  console.error(ts(), ...args);
}

// ─── Shell helpers ────────────────────────────────────────────────────

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function sh(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) =>
      resolve({ stdout, stderr, code: code ?? -1 }),
    );
    proc.on('error', (err) =>
      resolve({ stdout, stderr: stderr + err.message, code: -1 }),
    );
  });
}

async function shOk(
  label: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const r = await sh(cmd, args, opts);
  if (r.code !== 0) {
    logErr(`${label} FAILED (code ${r.code})`);
    if (r.stdout) logErr(r.stdout);
    if (r.stderr) logErr(r.stderr);
    throw new Error(`${label} failed`);
  }
  return r;
}

// ─── Cleanup tracking ─────────────────────────────────────────────────

interface CleanupCtx {
  branchToDelete: string | null;
  originalBranch: string | null;
  serverProc: ChildProcess | null;
  liveAgentIds: string[];
}
const ctx: CleanupCtx = {
  branchToDelete: null,
  originalBranch: null,
  serverProc: null,
  liveAgentIds: [],
};

async function cleanup(): Promise<void> {
  if (ctx.serverProc && !ctx.serverProc.killed && ctx.serverProc.pid) {
    log('cleanup: stopping next server (process group)');
    // next start (via pnpm) forks a next-server worker; killing only the
    // direct child orphans the worker holding the port. Spawn with
    // detached:true puts the children in their own process group so the
    // negative-pid trick reaches the whole tree.
    const pgid = -ctx.serverProc.pid;
    try {
      process.kill(pgid, 'SIGTERM');
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
    try {
      process.kill(pgid, 'SIGKILL');
    } catch {}
  }
  for (const id of ctx.liveAgentIds) {
    try {
      abortAgentCore(id);
    } catch {}
  }
  if (ctx.branchToDelete && ctx.originalBranch) {
    const cur = await sh('git', [
      '-C',
      TARGET_REPO,
      'branch',
      '--show-current',
    ]);
    if (cur.stdout.trim() === ctx.branchToDelete) {
      await sh('git', [
        '-C',
        TARGET_REPO,
        'checkout',
        ctx.originalBranch,
      ]);
    }
    await sh('git', [
      '-C',
      TARGET_REPO,
      'branch',
      '-D',
      ctx.branchToDelete,
    ]);
  }
}

let cleanupOnce = false;
async function cleanupOnceFn(): Promise<void> {
  if (cleanupOnce) return;
  cleanupOnce = true;
  try {
    await cleanup();
  } catch (err) {
    logErr('cleanup error', err);
  }
}

process.on('SIGINT', async () => {
  await cleanupOnceFn();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanupOnceFn();
  process.exit(143);
});

// ─── Preflight ────────────────────────────────────────────────────────

async function preflight(): Promise<{ originalBranch: string }> {
  log(`dogfood session id: ${SESSION_ID}`);
  log(`target repo: ${TARGET_REPO}`);

  // Scoped to examples/mixtape — the rest of the monorepo can have WIP,
  // we only care that the agents' target dir is clean so their commits
  // don't accidentally pick up unrelated edits.
  const status = await shOk(
    'preflight: git status --porcelain -- examples/mixtape',
    'git',
    ['-C', REPO_ROOT, 'status', '--porcelain', '--', 'examples/mixtape'],
  );
  if (status.stdout.trim().length > 0) {
    logErr(
      'preflight: examples/mixtape has uncommitted changes:\n' + status.stdout,
    );
    logErr('refusing to dogfood on a dirty target dir. commit/stash first.');
    throw new Error('dirty target dir');
  }

  const branch = await shOk(
    'preflight: git branch --show-current',
    'git',
    ['-C', TARGET_REPO, 'branch', '--show-current'],
  );
  const originalBranch = branch.stdout.trim();
  log(`preflight: target repo on branch '${originalBranch}', clean`);
  return { originalBranch };
}

// ─── Agent dispatch ───────────────────────────────────────────────────

interface AgentTrace {
  id: string;
  ack: DispatchAck | null;
  worktree: string | null;
  branch: string | null;
  /** SHA captured synchronously inside agent_finished (before worktree cleanup). */
  capturedSha: string | null;
  events: CodexEvent[];
  counts: Record<string, number>;
  finished: boolean;
  error: string | null;
}

function makeTrace(id: string): AgentTrace {
  return {
    id,
    ack: null,
    worktree: null,
    branch: null,
    capturedSha: null,
    events: [],
    counts: {},
    finished: false,
    error: null,
  };
}

/**
 * Sync git capture inside the agent_finished handler.
 *
 * The pool's streaming loop's finally{} block emits agent_finished
 * SYNCHRONOUSLY (our handler runs to completion), THEN it does
 * `await record.handle.cleanup()` (async) which deletes the worktree and
 * the branch. So execFileSync here is guaranteed to run while the
 * worktree still exists.
 *
 * We auto-commit any uncommitted changes (excluding AGENTS.md, which the
 * pool injected into the worktree root as the agent's task spec — it
 * doesn't belong in the merged history). Then capture HEAD. The commit
 * object survives `git branch -D` for ~2 weeks until git gc.
 */
function captureAgentSha(trace: AgentTrace): void {
  if (!trace.worktree) return;
  try {
    const status = execFileSync('git', [
      '-C',
      trace.worktree,
      'status',
      '--porcelain',
    ])
      .toString()
      .trim();
    if (status.length > 0) {
      log(`[${trace.id}] auto-committing leftover working-tree changes`);
      // Exclude AGENTS.md — the pool wrote it into the worktree root as
      // the agent's task spec. It's not part of the agent's deliverable
      // and would collide with the user's working tree on cherry-pick.
      execFileSync('git', [
        '-C',
        trace.worktree,
        'add',
        '-A',
        '--',
        '.',
        ':(exclude)AGENTS.md',
      ]);
      // If the agent already committed AGENTS.md themselves, strip it
      // from HEAD before our auto-commit. Cheap to run unconditionally.
      const inHead = execFileSync('git', [
        '-C',
        trace.worktree,
        'ls-tree',
        '-r',
        '--name-only',
        'HEAD',
      ])
        .toString()
        .split('\n')
        .includes('AGENTS.md');
      if (inHead) {
        log(`[${trace.id}] removing AGENTS.md from agent's HEAD commit`);
        execFileSync('git', [
          '-C',
          trace.worktree,
          '-c',
          'user.email=director@local',
          '-c',
          'user.name=Director Dogfood',
          'rm',
          '--cached',
          'AGENTS.md',
        ]);
        execFileSync('git', [
          '-C',
          trace.worktree,
          '-c',
          'user.email=director@local',
          '-c',
          'user.name=Director Dogfood',
          'commit',
          '--amend',
          '--no-edit',
        ]);
      }
      // Only commit if we still have staged changes after the exclusion.
      const staged = execFileSync('git', [
        '-C',
        trace.worktree,
        'diff',
        '--cached',
        '--name-only',
      ])
        .toString()
        .trim();
      if (staged.length > 0) {
        execFileSync('git', [
          '-C',
          trace.worktree,
          '-c',
          'user.email=director@local',
          '-c',
          'user.name=Director Dogfood',
          'commit',
          '-m',
          `dogfood: snapshot ${trace.id} working tree`,
        ]);
      }
    }
    const sha = execFileSync('git', [
      '-C',
      trace.worktree,
      'rev-parse',
      'HEAD',
    ])
      .toString()
      .trim();
    trace.capturedSha = sha;
    log(`[${trace.id}] captured HEAD ${sha.slice(0, 8)}`);
  } catch (err) {
    logErr(
      `[${trace.id}] SHA capture failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function attachOnEvent(trace: AgentTrace): (ev: CodexEvent) => void {
  return (ev) => {
    trace.events.push(ev);
    trace.counts[ev.type] = (trace.counts[ev.type] ?? 0) + 1;
    if (ev.type === 'agent_started') {
      trace.worktree = (ev.payload?.worktree as string) ?? null;
      trace.branch = (ev.payload?.branch as string) ?? null;
      log(`[${trace.id}] started in ${trace.worktree}`);
    } else if (ev.type === 'thread_started') {
      log(`[${trace.id}] thread ${ev.payload?.thread_id as string}`);
    } else if (ev.type === 'turn_completed') {
      log(`[${trace.id}] turn completed`);
    } else if (ev.type === 'error') {
      const msg =
        (ev.payload && (ev.payload.message as string)) ||
        JSON.stringify(ev.payload);
      trace.error = msg;
      logErr(`[${trace.id}] ERROR — ${msg}`);
    } else if (
      ev.type === 'file_change' &&
      (ev.payload?.phase as string) === 'item.completed'
    ) {
      const item = ev.payload?.item as Record<string, unknown> | undefined;
      const changes = (item?.changes as unknown[] | undefined) ?? [];
      log(`[${trace.id}] file_change — ${changes.length} change(s)`);
    } else if (
      ev.type === 'command_execution' &&
      (ev.payload?.phase as string) === 'item.completed'
    ) {
      const item = ev.payload?.item as Record<string, unknown> | undefined;
      const cmd =
        typeof item?.command === 'string'
          ? (item.command as string).slice(0, 80)
          : '(unknown)';
      log(`[${trace.id}] command — ${cmd}`);
    } else if (ev.type === 'agent_finished') {
      // CRITICAL: capture SHA synchronously, before the pool's await-cleanup
      // microtask runs and the worktree is torn down.
      captureAgentSha(trace);
      trace.finished = true;
      log(
        `[${trace.id}] FINISHED (aborted=${String(ev.payload?.aborted ?? false)})`,
      );
    }
  };
}

async function dispatchWithTimeout(
  req: DispatchAgentRequest,
  trace: AgentTrace,
  timeoutMs: number,
): Promise<void> {
  const onEvent = attachOnEvent(trace);
  trace.ack = await dispatchAgentCore(req, SESSION_ID, onEvent);
  if (!trace.ack.ok) {
    throw new Error(`[${trace.id}] dispatch failed: ${trace.ack.error}`);
  }
  ctx.liveAgentIds.push(trace.id);
  log(`[${trace.id}] dispatched → worktree ${trace.ack.worktree}`);

  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(() => {
      abortAgentCore(trace.id);
      reject(
        new Error(
          `[${trace.id}] timed out after ${(timeoutMs / 1000).toFixed(0)}s — aborted`,
        ),
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([waitForAgentCore(trace.id), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (trace.error) {
    throw new Error(`[${trace.id}] finished with error: ${trace.error}`);
  }
  if (!trace.finished) {
    throw new Error(`[${trace.id}] did not emit agent_finished`);
  }
  if (!trace.capturedSha) {
    throw new Error(`[${trace.id}] SHA capture failed — see logs above`);
  }
}

// ─── Merge worktree commits into dogfood branch ───────────────────────

async function mergeIntoDogfoodBranch(
  base: string,
  cherryShas: Array<{ agentId: string; sha: string }>,
): Promise<string> {
  const dogfoodBranch = `director/${SESSION_ID}`;
  ctx.branchToDelete = dogfoodBranch;
  log(`merge: creating ${dogfoodBranch} from ${base}`);
  await shOk(
    'merge: checkout -b',
    'git',
    ['-C', TARGET_REPO, 'checkout', '-b', dogfoodBranch, base],
  );

  for (const { agentId, sha } of cherryShas) {
    log(`merge: cherry-picking ${agentId} ${sha.slice(0, 8)}`);
    // The agent's branch was rooted on `base`, so cherry-pick should be a
    // trivial fast-forward-equivalent unless the agent's run included
    // unrelated commits ahead of base. We use cherry-pick (not merge) so
    // we get an explicit failure on conflict instead of an octopus mess.
    const r = await sh('git', [
      '-C',
      TARGET_REPO,
      'cherry-pick',
      '--allow-empty',
      sha,
    ]);
    if (r.code !== 0) {
      logErr(`merge: cherry-pick FAILED for ${agentId} (${sha})`);
      if (r.stdout) logErr(r.stdout);
      if (r.stderr) logErr(r.stderr);
      await sh('git', ['-C', TARGET_REPO, 'cherry-pick', '--abort']);
      throw new Error(
        `cherry-pick conflict for ${agentId} — non-overlapping scopes assumed`,
      );
    }
  }
  log(`merge: ${dogfoodBranch} ready`);
  return dogfoodBranch;
}

// ─── Build + serve + verify ───────────────────────────────────────────

async function mixtapeBuildAndStart(): Promise<{ port: number }> {
  log('mixtape: typecheck');
  await shOk(
    'mixtape typecheck',
    'pnpm',
    ['--filter', 'mixtape', 'typecheck'],
    { cwd: REPO_ROOT },
  );
  log('mixtape: typecheck OK');

  log('mixtape: build');
  await shOk(
    'mixtape build',
    'pnpm',
    ['--filter', 'mixtape', 'build'],
    { cwd: REPO_ROOT },
  );
  log('mixtape: build OK');

  // Pick a free ephemeral port up-front. mixtape's start script hardcodes
  // -p 3001, which collides with any leftover dev server / orphaned next-
  // server worker. Asking the OS for a free port and overriding via `next
  // start -p <port>` makes the dogfood resilient to whatever's listening.
  const port = await new Promise<number>((resolveP, rejectP) => {
    const probe = createServer();
    probe.once('error', rejectP);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      probe.close();
      if (addr && typeof addr === 'object') resolveP(addr.port);
      else rejectP(new Error('failed to allocate ephemeral port'));
    });
  });

  log(`mixtape: starting next server on :${port} (background, detached)`);
  const proc = spawn(
    'pnpm',
    ['--filter', 'mixtape', 'exec', 'next', 'start', '-p', String(port)],
    {
      cwd: REPO_ROOT,
      env: { ...process.env },
      detached: true,
    },
  );
  ctx.serverProc = proc;

  await new Promise<void>((resolveP, rejectP) => {
    const deadline = setTimeout(() => {
      rejectP(new Error('next server did not become ready within 30s'));
    }, 30_000);
    let buf = '';
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      // Match the port we requested explicitly — don't trust regex capture
      // to give us the right number if next prints multiple addresses.
      if (buf.includes(`:${port}`) && /Local:|Ready in/.test(buf)) {
        clearTimeout(deadline);
        proc.stdout.off('data', onData);
        proc.stderr.off('data', onData);
        resolveP();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => {
      clearTimeout(deadline);
      rejectP(new Error(`next server exited early with code ${code} — stdout/stderr buffer: ${buf.slice(-500)}`));
    });
  });

  // Brief grace period — next prints "Local" slightly before the listener
  // is actually accepting connections.
  await new Promise((r) => setTimeout(r, 750));

  log(`mixtape: next ready on port ${port}`);
  return { port };
}

interface ProbeResult {
  status: number;
  body: unknown;
}

async function probe(
  url: string,
  init: RequestInit = {},
): Promise<ProbeResult> {
  const res = await fetch(url, init);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text().catch(() => null);
  }
  return { status: res.status, body };
}

async function runApiAsserts(port: number): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  const id = 'test-dogfood-id';
  const sample = {
    id,
    vibe: 'dogfood vibe — late-night drive through tokyo neon',
    tracks: [
      { title: 'Midnight Driver', artist: 'Akira Vance', runtime: '4:12' },
      { title: 'Neon Rain', artist: 'Sable Sound', runtime: '5:02' },
    ],
    theme: 'cassette',
    createdAt: new Date().toISOString(),
  };

  log(`api: POST ${base}/api/mixtape/${id}`);
  const post = await probe(`${base}/api/mixtape/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sample),
  });
  if (post.status !== 200) {
    throw new Error(
      `POST expected 200, got ${post.status}: ${JSON.stringify(post.body)}`,
    );
  }
  const postBody = post.body as Record<string, unknown> | null;
  if (!postBody || postBody.id !== id || postBody.vibe !== sample.vibe) {
    throw new Error(
      `POST body did not echo Mixtape: ${JSON.stringify(post.body)}`,
    );
  }
  log('api: POST 200 — body echoes Mixtape');

  log(`api: GET ${base}/api/mixtape/${id}`);
  const get = await probe(`${base}/api/mixtape/${id}`);
  if (get.status !== 200) {
    throw new Error(
      `GET expected 200, got ${get.status}: ${JSON.stringify(get.body)}`,
    );
  }
  const getBody = get.body as Record<string, unknown> | null;
  if (!getBody || getBody.id !== id) {
    throw new Error(
      `GET body did not return Mixtape: ${JSON.stringify(get.body)}`,
    );
  }
  log('api: GET 200 — Mixtape persisted across requests');

  log(`api: GET ${base}/api/mixtape/does-not-exist (expect 404)`);
  const miss = await probe(`${base}/api/mixtape/does-not-exist`);
  if (miss.status !== 404) {
    throw new Error(
      `GET-404 expected 404, got ${miss.status}: ${JSON.stringify(miss.body)}`,
    );
  }
  log('api: GET-404 OK — missing id returns 404');
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { originalBranch } = await preflight();
  ctx.originalBranch = originalBranch;

  const cleo = makeTrace('cleo');
  const jin = makeTrace('jin');

  const cleoReq: DispatchAgentRequest = {
    agentId: 'cleo',
    name: 'Cleo',
    role: 'Data',
    task:
      'Implement lib/store.ts: readAll, getById, upsert backed by data/mixtapes.json. ' +
      'Use node:fs/promises. Atomic writes via tmp file + rename. Resolve paths ' +
      'relative to process.cwd(). Match the contract in the TODO comments at the top ' +
      'of the file. Validate against the Mixtape type from lib/schema.ts. Ensure the ' +
      'data/ directory is created if missing, and if data/mixtapes.json does not exist ' +
      'treat it as an empty array. After implementing, run `pnpm typecheck` to confirm. ' +
      'Commit your change atomically with a clear message.',
    targetRepo: TARGET_REPO,
  };

  const jinReq: DispatchAgentRequest = {
    agentId: 'jin',
    name: 'Jin',
    role: 'Backend',
    task:
      'Implement app/api/mixtape/[id]/route.ts GET and POST handlers using lib/store. ' +
      'GET returns 200 with Mixtape JSON, or 404 if missing. POST upserts the request ' +
      'body and returns the persisted Mixtape with 200. Use NextResponse.json. The ' +
      'Next.js 15 route param signature is already in place: ' +
      '`{ params: Promise<{ id: string }> }` — await params before reading id. ' +
      'For POST: validate that the body parses as a Mixtape (id/vibe/tracks/theme/createdAt) ' +
      'and that body.id matches the route id; if not, return 400. After implementing, ' +
      'run `pnpm typecheck` to confirm. Commit atomically with a clear message.',
    targetRepo: TARGET_REPO,
  };

  log('dispatching Cleo + Jin in parallel');
  const results = await Promise.allSettled([
    dispatchWithTimeout(cleoReq, cleo, 5 * 60_000),
    dispatchWithTimeout(jinReq, jin, 5 * 60_000),
  ]);

  const failures = results.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    for (const f of failures as PromiseRejectedResult[]) {
      logErr(
        'agent rejected:',
        f.reason instanceof Error ? f.reason.message : f.reason,
      );
    }
    throw new Error('one or more agents failed');
  }

  log('both agents finished');
  log(`  cleo events: ${JSON.stringify(cleo.counts)}`);
  log(`  jin  events: ${JSON.stringify(jin.counts)}`);

  if (!cleo.ack?.ok || !jin.ack?.ok) {
    throw new Error('agent dispatch ack missing — pool state corrupt');
  }
  if (!cleo.capturedSha || !jin.capturedSha) {
    throw new Error('captured SHA missing — see logs above');
  }

  await mergeIntoDogfoodBranch(originalBranch, [
    { agentId: 'cleo', sha: cleo.capturedSha },
    { agentId: 'jin', sha: jin.capturedSha },
  ]);

  // Sanity: confirm both target files no longer say "not implemented" / 501.
  // git show paths are repo-root-relative, not cwd-relative.
  const storeText = execFileSync('git', [
    '-C',
    TARGET_REPO,
    'show',
    'HEAD:examples/mixtape/lib/store.ts',
  ]).toString();
  if (/not implemented yet/i.test(storeText)) {
    throw new Error('lib/store.ts still contains "not implemented yet"');
  }
  const routeText = execFileSync('git', [
    '-C',
    TARGET_REPO,
    'show',
    'HEAD:examples/mixtape/app/api/mixtape/[id]/route.ts',
  ]).toString();
  if (/not implemented yet/i.test(routeText) || /\b501\b/.test(routeText)) {
    throw new Error(
      'app/api/mixtape/[id]/route.ts still returns 501 / "not implemented"',
    );
  }
  log('merged branch: both target files implement real behavior');

  const { port } = await mixtapeBuildAndStart();
  await runApiAsserts(port);
}

main().then(
  async () => {
    await cleanupOnceFn();
    log('DONE — dogfood passed');
    process.exit(0);
  },
  async (err) => {
    logErr('FAIL —', err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) logErr(err.stack);
    await cleanupOnceFn();
    process.exit(1);
  },
);
