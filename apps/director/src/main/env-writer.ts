/**
 * env-writer — small, pure-Node helper that writes a single key=value pair
 * into a `.env` file with atomic semantics (tmp + rename) while preserving
 * the rest of the file's content.
 *
 * Lives in main/ because Node `fs` only exists there, but the value-merging
 * logic is split into `mergeEnv()` (pure) so the unit tests can run under
 * vitest's node environment without touching the disk.
 *
 * Per docs/remaining-phases.md §6.6 (W5 lane). The ApiKeyMissing canvas
 * card sends the user-typed key over the `app.writeEnv` IPC; main calls
 * `writeEnvKey()` which targets the repo-root `.env` (matches the dotenv
 * load order in `main/index.ts`).
 *
 * Keychain mode is gated by `DIRECTOR_USE_KEYCHAIN=1` (architecture.md §11)
 * and intentionally NOT implemented here — that's a future ship-mode swap.
 */

import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppWriteEnvKey,
  AppWriteEnvRequest,
  AppWriteEnvResponse,
} from '../shared/ipc.js';

/** Closed allow-list. Keep narrow — every entry is user-supplied input. */
const WRITABLE_KEYS: ReadonlySet<AppWriteEnvKey> = new Set(['OPENAI_API_KEY']);

export interface ResolveEnvPathOptions {
  /** Override for tests. Defaults to the repo-root `.env`. */
  envPath?: string;
}

/**
 * Resolve the repo-root .env path. Mirrors the dotenv load order in
 * `main/index.ts` — repo-root wins over `apps/director/.env`.
 */
export function resolveDefaultEnvPath(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // here = apps/director/out/main (built) or apps/director/src/main (dev).
  // Both resolve up four parents to the repo root.
  return resolve(here, '..', '..', '..', '..', '.env');
}

/**
 * Pure helper. Given an existing .env file body (may be empty) and a
 * { key, value } pair, return the new body with the matching line replaced
 * (or appended). Preserves blank lines, comments, and key ordering.
 *
 * Conservative: only touches lines whose left-hand side (before the FIRST
 * `=`) exactly equals `key`. Lines whose key matches but include surrounding
 * whitespace (`KEY = value`) are also matched after trimming.
 */
export function mergeEnv(existing: string, key: string, value: string): string {
  const escapedValue = formatEnvValue(value);
  const lines = existing.length === 0 ? [] : existing.split(/\r?\n/);
  let replaced = false;
  const next = lines.map((line) => {
    if (replaced) return line;
    const eq = line.indexOf('=');
    if (eq <= 0) return line;
    const lhs = line.slice(0, eq).trim();
    if (lhs !== key) return line;
    replaced = true;
    return `${key}=${escapedValue}`;
  });
  if (!replaced) {
    // Ensure exactly one trailing newline before appending.
    if (next.length > 0 && next[next.length - 1] !== '') {
      next.push('');
    }
    next.push(`${key}=${escapedValue}`);
  }
  // Re-join. If the file used \r\n we lose that distinction; .env files
  // are LF on macOS so this is fine for our target platform.
  let out = next.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  return out;
}

/**
 * Wrap value in double quotes if it contains whitespace, `#`, or `=`.
 * Backslashes and double-quotes inside the value are escaped per the
 * de-facto dotenv quoting convention.
 */
function formatEnvValue(raw: string): string {
  const needsQuote = /[\s"#=\\]/.test(raw) || raw.length === 0;
  if (!needsQuote) return raw;
  const escaped = raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Validate a write request. Returns a normalized request or an error string.
 */
export function validateWriteEnvRequest(
  req: unknown,
): { ok: true; req: AppWriteEnvRequest } | { ok: false; error: string } {
  if (typeof req !== 'object' || req === null) {
    return { ok: false, error: 'missing payload' };
  }
  const r = req as { key?: unknown; value?: unknown };
  if (typeof r.key !== 'string') {
    return { ok: false, error: 'key must be a string' };
  }
  if (!WRITABLE_KEYS.has(r.key as AppWriteEnvKey)) {
    return { ok: false, error: `key "${r.key}" not on writable allow-list` };
  }
  if (typeof r.value !== 'string') {
    return { ok: false, error: 'value must be a string' };
  }
  if (r.value.length === 0 || r.value.length > 4096) {
    return { ok: false, error: 'value length out of range (1..4096)' };
  }
  return {
    ok: true,
    req: { key: r.key as AppWriteEnvKey, value: r.value },
  };
}

/**
 * Atomically merge a key=value pair into a `.env` file. Writes to `.tmp`,
 * fsyncs, then renames. Tolerates a missing target file (creates it).
 */
export async function writeEnvKey(
  req: AppWriteEnvRequest,
  options: ResolveEnvPathOptions = {},
): Promise<AppWriteEnvResponse> {
  const targetPath = options.envPath ?? resolveDefaultEnvPath();
  const validated = validateWriteEnvRequest(req);
  if (!validated.ok) return validated;
  const { key, value } = validated.req;
  try {
    let existing = '';
    try {
      existing = await fs.readFile(targetPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const merged = mergeEnv(existing, key, value);
    await fs.mkdir(dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.tmp`;
    const fh = await fs.open(tmp, 'w');
    try {
      await fh.writeFile(merged, 'utf8');
      try {
        await fh.sync();
      } catch {
        // Best-effort fsync; some FS impls reject it.
      }
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, targetPath);
    // Mirror the value into the live process so subsequent mints succeed
    // without a restart. This is the path that lets the user-supplied
    // key take effect immediately for the running session.
    process.env[key] = value;
    return { ok: true, path: targetPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return { ok: false, error: message };
  }
}
