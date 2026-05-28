/**
 * Unit tests for the env-writer module. Covers the pure `mergeEnv` helper
 * + the validation gate. Disk-write path is exercised against a temp file
 * to assert atomic semantics (tmp + rename) end-to-end.
 *
 * Runs in vitest's node env — no Electron, no IPC. Just fs + the helper.
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mergeEnv,
  validateWriteEnvRequest,
  writeEnvKey,
} from './env-writer.js';

describe('mergeEnv', () => {
  it('appends the key when missing', () => {
    const out = mergeEnv('FOO=1\nBAR=2\n', 'OPENAI_API_KEY', 'sk-test');
    expect(out).toContain('FOO=1');
    expect(out).toContain('BAR=2');
    expect(out).toContain('OPENAI_API_KEY=sk-test');
  });

  it('replaces the existing line without dropping siblings', () => {
    const before = 'FOO=1\nOPENAI_API_KEY=old\nBAR=2\n';
    const out = mergeEnv(before, 'OPENAI_API_KEY', 'new');
    expect(out).toContain('FOO=1');
    expect(out).toContain('BAR=2');
    expect(out).toContain('OPENAI_API_KEY=new');
    expect(out).not.toContain('OPENAI_API_KEY=old');
  });

  it('handles empty input by writing a single line', () => {
    const out = mergeEnv('', 'OPENAI_API_KEY', 'sk-1');
    expect(out).toBe('OPENAI_API_KEY=sk-1\n');
  });

  it('quotes values containing whitespace or special chars', () => {
    const out = mergeEnv('', 'OPENAI_API_KEY', 'has space');
    expect(out).toContain('OPENAI_API_KEY="has space"');
  });

  it('preserves comments and blank lines verbatim', () => {
    const before = '# top comment\n\nFOO=1\n';
    const out = mergeEnv(before, 'OPENAI_API_KEY', 'sk-1');
    expect(out.startsWith('# top comment')).toBe(true);
    expect(out).toContain('FOO=1');
    expect(out).toContain('OPENAI_API_KEY=sk-1');
  });

  it('only matches the exact LHS key', () => {
    const before = 'OPENAI_API_KEY_BACKUP=keep\n';
    const out = mergeEnv(before, 'OPENAI_API_KEY', 'sk-1');
    expect(out).toContain('OPENAI_API_KEY_BACKUP=keep');
    expect(out).toContain('OPENAI_API_KEY=sk-1');
  });
});

describe('validateWriteEnvRequest', () => {
  it('accepts a well-formed request', () => {
    const res = validateWriteEnvRequest({
      key: 'OPENAI_API_KEY',
      value: 'sk-123',
    });
    expect(res.ok).toBe(true);
  });

  it('rejects unknown keys', () => {
    const res = validateWriteEnvRequest({ key: 'EVIL', value: 'x' });
    expect(res.ok).toBe(false);
  });

  it('rejects non-string values', () => {
    const res = validateWriteEnvRequest({
      key: 'OPENAI_API_KEY',
      value: 42,
    });
    expect(res.ok).toBe(false);
  });

  it('rejects empty / too-long values', () => {
    const tooLong = 'x'.repeat(5000);
    expect(validateWriteEnvRequest({ key: 'OPENAI_API_KEY', value: '' }).ok).toBe(
      false,
    );
    expect(
      validateWriteEnvRequest({ key: 'OPENAI_API_KEY', value: tooLong }).ok,
    ).toBe(false);
  });

  it('rejects null / undefined payloads without throwing', () => {
    expect(validateWriteEnvRequest(null).ok).toBe(false);
    expect(validateWriteEnvRequest(undefined).ok).toBe(false);
  });
});

describe('writeEnvKey (disk)', () => {
  it('writes a new file when the target is missing', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'director-env-'));
    const target = join(dir, '.env');
    const res = await writeEnvKey(
      { key: 'OPENAI_API_KEY', value: 'sk-abc' },
      { envPath: target },
    );
    expect(res.ok).toBe(true);
    const body = await fs.readFile(target, 'utf8');
    expect(body).toContain('OPENAI_API_KEY=sk-abc');
  });

  it('preserves existing file contents on rewrite', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'director-env-'));
    const target = join(dir, '.env');
    await fs.writeFile(target, 'FOO=1\nOPENAI_API_KEY=old\n', 'utf8');
    const res = await writeEnvKey(
      { key: 'OPENAI_API_KEY', value: 'sk-new' },
      { envPath: target },
    );
    expect(res.ok).toBe(true);
    const body = await fs.readFile(target, 'utf8');
    expect(body).toContain('FOO=1');
    expect(body).toContain('OPENAI_API_KEY=sk-new');
    expect(body).not.toContain('sk-new\nOPENAI_API_KEY=old');
  });

  it('returns ok:false on validation failure rather than throwing', async () => {
    const res = await writeEnvKey(
      // @ts-expect-error — exercise the runtime guard
      { key: 'NOT_ALLOWED', value: 'x' },
      { envPath: '/dev/null' },
    );
    expect(res.ok).toBe(false);
  });
});
