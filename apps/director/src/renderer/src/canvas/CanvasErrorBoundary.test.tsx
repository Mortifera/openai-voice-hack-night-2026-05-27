/**
 * Unit tests for the CanvasErrorBoundary class component.
 *
 * React 19's `renderToString` does NOT exercise `componentDidCatch` —
 * server-side errors bubble out of the render call instead. The vitest
 * env here is `node` (no DOM), so we can't use `react-dom/client.createRoot`
 * either. Instead we test the boundary's pure state-machine surface
 * directly: `getDerivedStateFromError`, `getDerivedStateFromProps`, and
 * `render` against a mocked `state`/`props` pair. This is the same
 * behavior the runtime exercises, just without React doing the bookkeeping.
 *
 * Companion render-side tests for the four card components live in
 * `components/canvas-degrade.test.tsx`.
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { CanvasErrorBoundary } from './CanvasApp';
import type { CanvasRenderPayload } from '@shared/canvas-ipc';

const PAYLOAD: CanvasRenderPayload = {
  component: 'options_picker',
  props: {},
  component_id: 'card-1',
};

describe('CanvasErrorBoundary', () => {
  it('getDerivedStateFromError stores the error on state', () => {
    const next = (
      CanvasErrorBoundary as unknown as {
        getDerivedStateFromError: (err: Error) => { error: Error };
      }
    ).getDerivedStateFromError(new Error('boom'));
    expect(next.error.message).toBe('boom');
  });

  it('getDerivedStateFromProps clears error when payload changes', () => {
    const cls = CanvasErrorBoundary as unknown as {
      getDerivedStateFromProps: (
        next: { payload: CanvasRenderPayload },
        prev: { error: Error | null; triggeringComponent: string | null },
      ) => { error: Error | null; triggeringComponent: string | null } | null;
    };
    // No prior error → no transition.
    expect(
      cls.getDerivedStateFromProps(
        { payload: PAYLOAD },
        { error: null, triggeringComponent: null },
      ),
    ).toBe(null);
    // Same component → keep error.
    expect(
      cls.getDerivedStateFromProps(
        { payload: PAYLOAD },
        { error: new Error('x'), triggeringComponent: 'options_picker' },
      ),
    ).toBe(null);
    // New component → reset error.
    expect(
      cls.getDerivedStateFromProps(
        { payload: { ...PAYLOAD, component: 'moodboard' } },
        { error: new Error('x'), triggeringComponent: 'options_picker' },
      ),
    ).toEqual({ error: null, triggeringComponent: null });
  });

  it('render emits the CanvasError fallback when error state is populated', () => {
    // Construct the class manually so we can drive render with a
    // pre-set state. React's class lifecycle is just an object —
    // the test verifies the render branch in isolation.
    const instance = new (CanvasErrorBoundary as unknown as new (props: {
      payload: CanvasRenderPayload;
      onRetry?: () => void;
      children: null;
    }) => {
      state: { error: Error | null; triggeringComponent: string | null };
      render: () => React.ReactNode;
    })({ payload: PAYLOAD, onRetry: () => {}, children: null });
    instance.state = {
      error: new Error('caught-render-boom'),
      triggeringComponent: 'options_picker',
    };
    const html = renderToString(<>{instance.render() as React.ReactNode}</>);
    expect(html).toContain('Canvas error');
    expect(html).toContain('caught-render-boom');
    expect(html).toContain('options_picker');
    expect(html).toMatch(/Retry/);
  });

  it('render passes children through when no error is set', () => {
    const instance = new (CanvasErrorBoundary as unknown as new (props: {
      payload: CanvasRenderPayload;
      children: React.ReactNode;
    }) => {
      state: { error: Error | null; triggeringComponent: string | null };
      render: () => React.ReactNode;
    })({
      payload: PAYLOAD,
      children: <div id="happy-path">all good</div>,
    });
    instance.state = { error: null, triggeringComponent: null };
    const html = renderToString(<>{instance.render() as React.ReactNode}</>);
    expect(html).toContain('all good');
    expect(html).not.toContain('Canvas error');
  });
});
