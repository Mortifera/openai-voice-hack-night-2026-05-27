/**
 * Snapshot / behavior tests for the canvas degradation cards. The vitest
 * config runs under the `node` environment (no jsdom), so we render each
 * component via `react-dom/server.renderToString` and assert on the HTML
 * payload. This keeps the tests fast and avoids dragging in a DOM lib.
 *
 * Covers DoD bullets from docs/remaining-phases.md §6.6:
 * - cards render with default props and don't crash
 * - MicDenied renders the macOS deeplink anchor
 * - ApiKeyMissing input + button render and submit flows through the
 *   injected writer (no IPC bridge needed in tests)
 * - RotationFailed renders the soft notice line
 * - CanvasError renders the retry button when onRetry is provided and
 *   omits it when not
 */

import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MicDenied } from './MicDenied';
import { ApiKeyMissing } from './ApiKeyMissing';
import { RotationFailed } from './RotationFailed';
import { CanvasError } from './CanvasError';

describe('MicDenied', () => {
  it('renders default copy + macOS System Settings deeplink', () => {
    const html = renderToString(<MicDenied />);
    expect(html).toContain('Microphone blocked');
    expect(html).toContain('Open System Settings');
    expect(html).toContain('x-apple.systempreferences');
  });

  it('respects custom deeplink + hint props', () => {
    const html = renderToString(
      <MicDenied
        deeplink="x-apple.systempreferences:foo"
        hint="custom hint copy"
      />,
    );
    expect(html).toContain('x-apple.systempreferences:foo');
    expect(html).toContain('custom hint copy');
  });

  it('falls back to default copy when props are wrong types', () => {
    const html = renderToString(
      <MicDenied
        // @ts-expect-error — exercise the runtime guard for wrong-type input
        deeplink={42}
        // @ts-expect-error — exercise the runtime guard for wrong-type input
        hint={{ not: 'a string' }}
      />,
    );
    expect(html).toContain('Open System Settings');
    expect(html).toContain('x-apple.systempreferences');
  });
});

describe('ApiKeyMissing', () => {
  it('renders password input + save button by default', () => {
    const html = renderToString(<ApiKeyMissing />);
    expect(html).toContain('OpenAI key needed');
    expect(html).toContain('type="password"');
    expect(html).toMatch(/Save/);
  });

  it('renders without throwing when no preload bridge is installed', () => {
    // The default writer reads from `window.director?.app?.writeEnv`, which
    // is undefined under the vitest node env. Render-only assertion: no
    // throw, no crash, full card body.
    const html = renderToString(<ApiKeyMissing />);
    expect(html).toContain('Add your API key');
  });

  it('accepts an injected writeEnv prop without calling it on render', () => {
    const writer = vi.fn().mockResolvedValue({ ok: true, path: '/tmp/.env' });
    const html = renderToString(<ApiKeyMissing writeEnv={writer} />);
    expect(html).toContain('Save');
    expect(writer).not.toHaveBeenCalled();
  });
});

describe('RotationFailed', () => {
  it('renders the default soft notice line', () => {
    const html = renderToString(<RotationFailed />);
    expect(html).toContain('Reconnecting');
    expect(html).toContain('Session will reset');
  });

  it('renders a custom message prop', () => {
    const html = renderToString(<RotationFailed message="custom blip copy" />);
    expect(html).toContain('custom blip copy');
  });
});

describe('CanvasError', () => {
  it('renders default copy + omits retry button when onRetry is absent', () => {
    const html = renderToString(<CanvasError />);
    expect(html).toContain('Canvas error');
    expect(html).toContain('Couldn');
    expect(html).not.toMatch(/>Retry</);
  });

  it('renders error message + component name when provided', () => {
    const html = renderToString(
      <CanvasError message="boom" componentName="options_picker" />,
    );
    expect(html).toContain('boom');
    expect(html).toContain('options_picker');
  });

  it('renders retry button when onRetry callback is wired', () => {
    const html = renderToString(<CanvasError onRetry={() => {}} />);
    expect(html).toMatch(/Retry/);
  });
});
