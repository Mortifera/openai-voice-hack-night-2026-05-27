/**
 * ApiKeyMissing — degradation card shown when the realtime mint endpoint
 * returns 401 (or boot detects no `OPENAI_API_KEY`). Renders a single-line
 * password input + save button. Submit invokes the main-process
 * `app.writeEnv` IPC (exposed via the Canvas preload bridge) which writes
 * the value back to the project `.env` file with atomic semantics.
 *
 * Per docs/remaining-phases.md §6.6 (W5 lane). Keychain integration is
 * intentionally out-of-scope for this lane — the `DIRECTOR_USE_KEYCHAIN=1`
 * env flag in architecture.md §11 would gate a future keychain path; today
 * we always write to `.env`.
 *
 * Pure presentational + a single IPC effect. Defensive against missing
 * preload bridge: if `window.director?.app?.writeEnv` is absent (e.g. the
 * canvas window is loaded without the new preload during a rolling deploy),
 * we surface an inline error rather than throwing.
 */

import { useState, type FormEvent, type JSX } from 'react';
import type { AppWriteEnvResponse } from '@shared/ipc';

export interface ApiKeyMissingProps {
  /** Optional override copy. */
  message?: string;
  /** Test seam — inject a fake writer instead of using window.director. */
  writeEnv?: (key: string, value: string) => Promise<AppWriteEnvResponse>;
  /** Called after a successful save, before parent dismisses. */
  onSaved?: () => void;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string }
  | { kind: 'saved' };

function defaultWriteEnv(
  key: string,
  value: string,
): Promise<AppWriteEnvResponse> {
  const bridge = (
    window as unknown as {
      director?: {
        app?: {
          writeEnv?: (req: {
            key: 'OPENAI_API_KEY';
            value: string;
          }) => Promise<AppWriteEnvResponse>;
        };
      };
    }
  ).director?.app?.writeEnv;
  if (typeof bridge !== 'function') {
    return Promise.resolve({
      ok: false,
      error: 'preload bridge unavailable',
    } satisfies AppWriteEnvResponse);
  }
  // Coerce to the closed-enum key. Today we only ship one entry.
  return bridge({
    key: key === 'OPENAI_API_KEY' ? 'OPENAI_API_KEY' : 'OPENAI_API_KEY',
    value,
  });
}

export function ApiKeyMissing({
  message,
  writeEnv,
  onSaved,
}: ApiKeyMissingProps = {}): JSX.Element {
  const [value, setValue] = useState('');
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const writer = writeEnv ?? defaultWriteEnv;

  const body =
    typeof message === 'string' && message.length > 0
      ? message
      : 'Paste an OpenAI API key. Saved to .env on this machine — never leaves the box.';

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      setState({ kind: 'error', message: 'Key cannot be empty.' });
      return;
    }
    setState({ kind: 'saving' });
    try {
      const res = await writer('OPENAI_API_KEY', trimmed);
      if (res.ok) {
        setState({ kind: 'saved' });
        try {
          onSaved?.();
        } catch (err) {
          console.warn('[api-key-missing] onSaved threw', err);
        }
      } else {
        setState({ kind: 'error', message: res.error });
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Unknown error';
      setState({ kind: 'error', message: text });
    }
  };

  const isSaving = state.kind === 'saving';
  const isSaved = state.kind === 'saved';

  return (
    <div className="canvas-degrade" role="alert" aria-live="assertive">
      <span className="canvas-eyebrow">OpenAI key needed</span>
      <div className="canvas-title">Add your API key</div>
      <p className="canvas-degrade-body">{body}</p>
      <form
        className="canvas-degrade-form"
        onSubmit={(e) => {
          void onSubmit(e);
        }}
        data-no-drag
      >
        <input
          className="canvas-degrade-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-…"
          aria-label="OpenAI API key"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={isSaving || isSaved}
          data-no-drag
        />
        <button
          type="submit"
          className="canvas-degrade-button"
          disabled={isSaving || isSaved}
          data-no-drag
        >
          {isSaving ? 'Saving…' : isSaved ? 'Saved' : 'Save'}
        </button>
      </form>
      {state.kind === 'error' ? (
        <span className="artifact-meta canvas-degrade-error" role="status">
          {state.message}
        </span>
      ) : null}
      {isSaved ? (
        <span className="artifact-meta" role="status">
          Restart Director to pick up the new key.
        </span>
      ) : null}
    </div>
  );
}
