# Codex for (Almost) Everything — Research Notes for Director

> Investigation of OpenAI's May 2026 Codex announcement, with a Director-specific verdict on whether it can serve as our sub-agent execution layer.
>
> Sources: [openai.com/index/codex-for-almost-everything](https://openai.com/index/codex-for-almost-everything), [developers.openai.com/codex/cli](https://developers.openai.com/codex/cli), [developers.openai.com/codex/sdk](https://developers.openai.com/codex/sdk), [developers.openai.com/codex/noninteractive](https://developers.openai.com/codex/noninteractive), [github.com/openai/codex](https://github.com/openai/codex), [developers.openai.com/codex/pricing](https://developers.openai.com/codex/pricing).

---

## 1. What Codex actually is now

The May 2026 announcement positions Codex as the umbrella brand for OpenAI's coding agent. It is not one product — it is four surfaces sharing the same agent runtime:

1. **Codex CLI** — a Rust binary that runs an agentic loop on your local machine. Reads/writes files, executes shell commands, calls MCP tools. Distributed as `npm i -g @openai/codex`, a Homebrew cask, or a curl-piped installer.
2. **Codex Cloud (Web)** — long-running agent on OpenAI-managed devboxes, accessible from chatgpt.com/codex, with in-app browser, SSH-into-devbox, scheduled tasks across days.
3. **Codex App** — native macOS/Windows desktop with built-in git worktree management for running several agents in parallel on one repo. (This is conceptually what *we* are trying to build at a higher altitude — Director adds voice orchestration and structured judgment calls on top.)
4. **Codex SDK + GitHub Action** — programmatic surfaces that wrap the same runtime. The TypeScript SDK (`@openai/codex-sdk`) and Python SDK (`codex_app_server`) both shell out to the CLI under the hood and exchange JSONL events over stdio.

The default model is **`gpt-5.3-codex`** (specialized for agentic coding, cheapest agentic tier). `gpt-5.4` and the new **`gpt-5.5`** (April 23 2026, first fully retrained base since GPT-4.5, explicitly agentic-first) are selectable via `/model` or `--model`. The CLI also supports `--oss` for local Ollama models — useful as a fallback path.

> **Implication for Director:** "Codex" is no longer just the open-source TUI we knew. There is now a first-party SDK that is *designed* for what we are doing — embedding the Codex agent inside another agent. We should target the SDK as the sub-agent layer rather than scraping the TUI or building our own Responses-API loop.

---

## 2. How to invoke it

### 2a. Non-interactive CLI (`codex exec`)

The headless mode is the workhorse for orchestration. Flags worth knowing:

| Flag | Purpose |
|---|---|
| `codex exec "<prompt>"` | Single-shot run; final message → stdout, progress → stderr |
| `codex exec -` | Read full prompt from stdin |
| `--json` (alias `--experimental-json`) | Emit JSONL event stream to stdout instead of plain text |
| `--cd <path>` / `-C` | Set working directory before agent starts (this is how we point each agent at its worktree) |
| `--model gpt-5.3-codex` | Pick model per invocation |
| `--sandbox read-only \| workspace-write \| danger-full-access` | Filesystem/exec policy |
| `--ask-for-approval untrusted \| on-request \| never` | Approval gate (we want `never` + a tight sandbox) |
| `--full-auto` | Convenience for `--sandbox workspace-write --ask-for-approval never` |
| `--yolo` / `--dangerously-bypass-approvals-and-sandbox` | Skip everything (don't use in production) |
| `--output-schema <path>` | Constrain final message to a JSON Schema |
| `-o / --output-last-message <file>` | Write the final agent message to a file |
| `--ephemeral` | Don't persist session rollout to `~/.codex/sessions` |
| `--add-dir <path>` | Grant write access to an additional dir (e.g. shared `lib/schema.ts`) |
| `--ignore-user-config`, `--ignore-rules` | Bypass `$CODEX_HOME/config.toml` and rule files for hermetic runs |
| `--skip-git-repo-check` | Allow execution outside a git repo |
| `--profile <name>` / `-p` | Layer a named config profile from `config.toml` |
| `--config k=v` / `-c` | Override config keys inline |
| `codex exec resume <SESSION_ID>` / `--last` | Continue an earlier headless run |

Example: dispatch the Mixtape backend agent to its worktree, emit JSONL, structured final message:

```bash
codex exec \
  --cd /tmp/director/mixtape/worktrees/jin-backend \
  --model gpt-5.3-codex \
  --sandbox workspace-write \
  --ask-for-approval never \
  --json \
  --output-schema ./schemas/agent-final.json \
  --output-last-message ./out/jin.json \
  --ephemeral \
  - <<'PROMPT'
You are Jin, Director's backend specialist on the Mixtape project. ...
PROMPT
```

### 2b. TypeScript SDK (`@openai/codex-sdk`)

The SDK is a thin Node wrapper that spawns the Rust CLI as a subprocess and streams JSONL events over its stdio. **This is the right entrypoint for Director.**

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex({
  // env: control which vars the CLI subprocess sees
  env: { OPENAI_API_KEY: process.env.DIRECTOR_OPENAI_KEY! },
  // config: dotted-path overrides flattened to TOML at spawn time
  config: { model: "gpt-5.3-codex", sandbox_mode: "workspace-write" },
});

const thread = codex.startThread({
  workingDirectory: "/tmp/director/mixtape/worktrees/jin-backend",
  skipGitRepoCheck: false,
});

const { events, result } = await thread.runStreamed(jinSystemPromptPlusTask);
for await (const ev of events) {
  if (ev.type === "item.completed") {
    switch (ev.item.type) {
      case "agent_message":      /* surface to State Machine */ break;
      case "reasoning":          /* discard or store for replay */ break;
      case "command_execution":  /* update Hive micro-text trail */ break;
      case "file_change":        /* "writing CoverArt.tsx…" */ break;
      case "mcp_tool_call":      /* tool invocation */ break;
      case "web_search":         /* surface as a sub-step */ break;
      case "todo_list":          /* plan updates */ break;
      case "error":              /* mark agent blocked → amber */ break;
    }
  }
  if (ev.type === "turn.completed") {
    /* usage stats: input/output/cached tokens, cost in credits */
  }
}
```

Key SDK affordances confirmed from the README:

- `Codex` constructor: `{ env, config, baseUrl }`.
- `codex.startThread({ workingDirectory, skipGitRepoCheck })` and `codex.resumeThread(id)`.
- `thread.run(prompt, { outputSchema })` returns the final message.
- `thread.runStreamed(prompt)` returns `{ events: AsyncGenerator, ... }`.
- Threads persist to `~/.codex/sessions/<id>` and can be re-attached with `resumeThread`.
- AbortController/AbortSignal is supported, so we can cancel mid-flight on user "stop".

> **Implication for Director:** The SDK gives us exactly the shape Director needs: one Codex instance per agent, each pointing at its own worktree, each yielding structured events we can map 1:1 onto the State Machine's `agent.status` / `agent.microtext` fields. We do not need to write our own `child_process.spawn` wrapper — the SDK already is that, and stays in sync with the Rust CLI's protocol.

### 2c. The JSONL event stream (the load-bearing piece)

`item.completed` events carry an `item` object whose `type` field is one of:

```
agent_message | reasoning | command_execution | file_change |
mcp_tool_call | collab_tool_call | web_search | todo_list | error
```

Plus envelope events: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `error`.

This is essentially the canonical event taxonomy we sketched in `ux-design.md`'s State Machine ("writing PlaylistCard.tsx", "running tests", "blocked"). Codex emits it for us.

> **Implication for Director:** Our State Machine doesn't need to invent an event vocabulary. We adopt Codex's `item` types as the canonical sub-agent event schema, and our State Machine becomes a fan-in of N parallel event streams (one per agent) that drives both the Hive UI and the gpt-5.5 orchestrator's awareness.

---

## 3. Authentication & pricing

### Auth modes

Two paths, mutually exclusive per invocation:

1. **ChatGPT login** — `codex login` opens a browser, ties the binary to a Plus/Pro/Business/Edu/Enterprise plan. Usage debits *credits* against that plan. Default and recommended for humans.
2. **API key** — `OPENAI_API_KEY` (and the per-invocation `CODEX_API_KEY` form for CI). Bills directly to the OpenAI org in dollars per million tokens. No credit envelope, no plan rate limits — but no plan discount either.

You can set the SDK's `env` to pin a specific key per subprocess, which means **Director's four parallel agents can either share one API key or, more cleanly, share a single ChatGPT-Pro session's credit pool.**

### Pricing snapshot (API-key mode, May 2026)

| Model | Input / 1M | Cached input / 1M | Output / 1M |
|---|---|---|---|
| gpt-5.5 | 125 credits | 12.50 | 750 |
| gpt-5.4 | 62.50 | 6.25 | 375 |
| gpt-5.3-codex | 43.75 | 4.375 | 350 |

(Credits map ~1:1 to dollars for the listed rates on the dev portal; ChatGPT plan credits are a separate envelope on top.)

ChatGPT Pro ($100) gets 5× Plus limits (10× through May 31 2026 via promo). Pro $200 is 20× Plus ongoing, 25× during the promo window. Plus/Business share a **five-hour rolling window** for local + cloud usage combined — *this is the constraint that matters for a four-agent parallel run.*

> **Implication for Director:** For a 7-minute four-agent demo on `gpt-5.3-codex`, a Pro $100 plan is comfortably inside the credit envelope; a Plus plan is borderline (four parallel agents on one five-hour window can saturate during back-to-back demos). For the hackathon we should default to ChatGPT login on a Pro account; expose an "API key" toggle in Preferences for users who want metered billing instead of plan credits.

---

## 4. Concurrency & sandboxing

The CLI is **explicitly designed to run as multiple concurrent processes against the same repo via git worktrees** — this is OpenAI's own recommendation in the Codex docs and parroted in every third-party orchestration writeup.

- Each agent gets its own `git worktree add ../agent-<name> <branch>`.
- Worktrees share the `.git` object DB but have independent working dirs, HEAD, index — no file collisions.
- The CLI guards each subprocess with the sandbox: `workspace-write` is the right default (writes only inside the working dir + any `--add-dir` paths, denies network exec except an allowlist).
- Community wisdom: **3–5 concurrent agents is the practical ceiling** on a single Mac (~8–10 GB RAM each at peak), and dev-server ports collide if agents spin up local servers — index them by worktree.

Failure modes to plan around:

- Token cost scales linearly with parallelism. Set a per-agent budget and auto-pause at 85%.
- Agents stuck in a 3+ iteration loop on the same error must be force-killed and surfaced as blockers.
- A shared database/file (`lib/schema.ts` in Mixtape's case) is the canonical race-condition hazard — convention is to write the contract file first, *serially*, before fanning out.

> **Implication for Director:** Mixtape's four-agent split (`frontend`, `backend`, `data`, `design`) maps cleanly onto four worktrees. The Mixtape plan already does the right thing — `data-agent` writes `lib/schema.ts` first, then the others fan out. We should formalize that as a **Phase 0 serial step** in the orchestrator before parallel dispatch. Four agents on a Mac is the soft ceiling; we are at the limit but inside it.

---

## 5. Customizing agent personality

Three layered mechanisms, in decreasing order of "load-bearing-ness":

1. **`AGENTS.md` files** — Codex auto-merges `~/.codex/AGENTS.md` + every `AGENTS.md` from repo root down to CWD, injects each merged chunk as a user-role message prefixed `# AGENTS.md instructions for <dir>`. The model is trained to honor these tightly. Override order: `AGENTS.override.md` > `AGENTS.md` > `TEAM_GUIDE.md` > `.agents.md`.
2. **Prompt prefix** — anything you pass as the first turn becomes the de facto system prompt for that thread. The SDK doesn't expose a separate `system` slot; you concatenate role into the first user message.
3. **`/personality` slash command + config profiles** — runtime tone tweaks; not strong enough for "Jin specializes in Next.js API routes and only edits `app/api/**`".

For Director's named agents we want (1) + (2): drop a `.director/agents/<name>.md` per agent into its worktree at spawn time, plus prepend a 200-word role brief to the first prompt. This is the same pattern Codex's own multi-agent docs recommend.

> **Implication for Director:** Agent personalities ("Maya = Frontend", "Jin = Backend", "Vera = Design", "Otto = Data") are first-class via `AGENTS.md` injection. We don't need a fine-tuned model or a custom system prompt API — we generate per-agent markdown files from the Harness at dispatch time and drop them into the worktree.

---

## 6. Director-specific verdict

### 6.1 Can we use Codex SDK as the sub-agent layer as designed?

**Yes, almost exactly as designed.** The architecture from `vision.md` (four parallel Codex subprocesses, each with custom system prompt for its role, working in isolated git worktrees, status streamed to a central State Machine) is the *intended* use case of `@openai/codex-sdk` — the SDK readme essentially describes Director's sub-agent layer minus the voice + orchestrator + Canvas pieces.

Mapping:

| Director concept | Codex SDK primitive |
|---|---|
| Sub-agent (Maya/Jin/Vera/Otto) | One `Codex.startThread({ workingDirectory })` per agent |
| Agent's personality | `AGENTS.md` in worktree + role brief in first prompt |
| Worktree isolation | Standard `git worktree add` before `startThread` |
| Live micro-text trail in Hive | `item.completed` events of types `command_execution`, `file_change` |
| Agent done | `turn.completed` with no follow-up needed |
| Agent blocked → amber | `error` item OR explicit `agent_message` containing a structured blocker (we constrain final message via `outputSchema`) |
| Stop / kill on user command | `AbortController` passed to `runStreamed` |
| Follow-up instruction mid-flight | `thread.run("…")` after current turn completes; or wait-and-inject inside the same thread |
| Resume after Director quit | `codex.resumeThread(persistedId)` |

The one nuance: Codex's thread model is **turn-based**. You can't shove a follow-up into a turn that's still running — you have to either let it complete and call `thread.run` again, or `abort()` and start a new turn with the combined instruction. For Director's interactive "wait, also do X" voice flow, the right pattern is: queue the user's follow-up in our State Machine, wait for the current `turn.completed`, then dispatch as the next turn on the same thread.

### 6.2 Spawn / supervise sketch (Node/TS)

```ts
import { Codex } from "@openai/codex-sdk";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

type AgentName = "maya" | "jin" | "vera" | "otto";

interface DirectorAgent {
  name: AgentName;
  thread: ReturnType<Codex["startThread"]>;
  abort: AbortController;
  worktree: string;
}

async function dispatchAgent(
  codex: Codex,
  name: AgentName,
  roleBrief: string,
  task: string,
  repoRoot: string,
  branch: string,
  onEvent: (name: AgentName, ev: any) => void,
): Promise<DirectorAgent> {
  // 1. Create isolated worktree
  const worktree = path.join("/tmp/director", path.basename(repoRoot), "worktrees", name);
  mkdirSync(path.dirname(worktree), { recursive: true });
  execSync(`git -C ${repoRoot} worktree add -B agent/${name} ${worktree} ${branch}`);

  // 2. Drop agent personality into worktree as AGENTS.md
  writeFileSync(path.join(worktree, "AGENTS.md"), roleBrief);

  // 3. Start a Codex thread pointed at the worktree
  const thread = codex.startThread({
    workingDirectory: worktree,
    skipGitRepoCheck: false,
  });

  // 4. Wire abort + event fan-out
  const abort = new AbortController();
  const { events } = await thread.runStreamed(task, { signal: abort.signal });

  (async () => {
    try {
      for await (const ev of events) onEvent(name, ev);
    } catch (err) {
      if ((err as any).name !== "AbortError") onEvent(name, { type: "error", error: err });
    }
  })();

  return { name, thread, abort, worktree };
}

// In the State Machine reducer:
function handleAgentEvent(name: AgentName, ev: any, state: DirectorState) {
  if (ev.type === "item.completed") {
    switch (ev.item.type) {
      case "command_execution":
        state.agents[name].microtext = `running ${ev.item.command}`;
        break;
      case "file_change":
        state.agents[name].microtext = `${ev.item.action} ${ev.item.path}`;
        break;
      case "agent_message":
        // structured blocker schema enforced via outputSchema
        if (ev.item.parsed?.blocker) {
          state.agents[name].status = "blocked";
          state.escalations.push({ agent: name, reason: ev.item.parsed.blocker });
        }
        break;
      case "error":
        state.agents[name].status = "blocked";
        break;
    }
  }
  if (ev.type === "turn.completed") {
    state.agents[name].status = "done";
  }
}

// On user "stop everyone":
function stopAll(agents: DirectorAgent[]) {
  for (const a of agents) a.abort.abort();
}

// Mid-flight follow-up (queue until current turn ends):
async function inject(agent: DirectorAgent, msg: string) {
  // wait for current turn to settle, then run next turn on same thread
  await agent.thread.waitForIdle();
  return agent.thread.runStreamed(msg);
}
```

### 6.3 Blockers and gotchas

1. **Auth: one ChatGPT login is shared across all four subprocesses.** The SDK inherits the parent process env; we cannot have four *different* ChatGPT users in one Director session. For the hackathon this is fine (the demoer logs in once). For multi-user Director (post-hackathon), we'd need to switch to per-agent API keys.
2. **Five-hour rolling rate window on Plus/Business** is a real risk if we re-run the Mixtape demo 4+ times in a row on a Plus account. Mitigation: demo on Pro, or carry an API-key fallback.
3. **Sandbox cannot reach the public internet for arbitrary fetches by default.** `workspace-write` allows package-manager network calls but blocks arbitrary curl/wget. Our `backend-agent`'s "missing Spotify API key" blocker moment works *because* of this sandbox, not despite it — good.
4. **Turn-based, not stream-injectable.** A user saying "wait, also do X" mid-turn requires either an abort-and-rerun or a wait-for-`turn.completed` then dispatch. The latter is cleaner narratively; the former is responsive but loses partial work. Design choice for Pass 4 of `ux-design.md`.
5. **Four concurrent Rust subprocesses cost RAM** (8–10 GB peak each, per community measurements). A 32 GB MacBook is comfortable; a 16 GB one will swap. Add a preflight check.
6. **No first-party way to inject a true "system" message.** All steering goes through the first user turn + `AGENTS.md`. Live with it.
7. **JSONL event schema is "experimental"** — the flag is `--json` aliased from `--experimental-json`. OpenAI reserves the right to change it. Lock our integration against the SDK (which handles version drift) rather than the raw CLI JSON.
8. **The Codex App itself does what Director does at the IDE layer.** We are not a competitor (we are voice-first, decoupled from any single repo, and orchestrated by a separate planner model) — but we should clearly call out the differentiator: Director is the *attended-parallelization voice loop*, not "a better Codex app."

### 6.4 Fallbacks if the SDK doesn't fit

- **Plan B — raw `codex exec` subprocess.** Spawn the CLI ourselves with `child_process.spawn`, pipe `--json` through a JSONL parser. Loses the AbortController affordance, gains zero benefit. Only if SDK breaks for us.
- **Plan C — Responses API with `gpt-5-codex` model + our own agent loop.** Direct OpenAI Responses API call with the model name, we write the tool-use loop, sandboxing, file I/O ourselves. ~2 weeks of work. Higher control, much more code to maintain, no AGENTS.md auto-merging.
- **Plan D — older open-source `codex` (pre-SDK).** Same Rust binary, no SDK wrapper. Effectively equivalent to Plan B.
- **Plan E — Claude Code / Cursor Agent / Aider as sub-agents.** Same orchestration shape, different binary. Useful as a "Director is model-agnostic" story post-hackathon. Not for May 27.

The SDK is the right primary path. Plan B/C are real, achievable backups; pick Plan C only if we discover a fatal limitation in turn-based interaction during the hackathon build.

---

## 7. Open questions

1. **Does `runStreamed` accept an `AbortSignal` on the current SDK version, or do we need to call a thread-level `cancel()`?** Search results suggest yes but the public README is ambiguous — we need to read the actual TypeScript types in `node_modules/@openai/codex-sdk` after install.
2. **What is the exact JSON shape of an `item.completed` payload for `file_change`?** (Fields: `path`, `action`, `diff`?) We need this to render the Hive micro-text faithfully. Verify by running `codex exec --json` once and dumping events.
3. **Can `outputSchema` be enforced on intermediate `agent_message` items, or only the final message?** Director's blocker-detection logic depends on the answer.
4. **Does ChatGPT-login authentication survive across four subprocesses started simultaneously?** (Token refresh races.) Or do we need to gate startup serially behind a successful first auth call?
5. **What happens when a sub-agent emits an MCP tool call that itself takes 30 s?** Does the SDK's event loop keep streaming, or does it pause? Affects whether the Hive ring stays green or stalls.
6. **Is there a way to constrain a Codex sub-agent's filesystem visibility to a subdirectory of the worktree (e.g. Maya only sees `app/` and `components/`)?** `--add-dir` adds writable paths, but is there a `--restrict-dir` inverse?
7. **Token-budget enforcement: does the SDK expose a per-turn or per-thread token cap, or do we have to compute it from `turn.completed.usage` and abort manually?**
8. **Will OpenAI keep the JSONL `--experimental-json` schema stable through the hackathon weekend (May 27)?** We should pin a specific SDK version in `package.json` and not auto-upgrade between rehearsal and demo.

---

*Last updated: 2026-05-27.*
