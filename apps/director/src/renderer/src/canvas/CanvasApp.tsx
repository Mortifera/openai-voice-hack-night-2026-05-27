/**
 * Canvas root — routes `canvas.render` IPC events to the matching GenUI
 * component, animates slide-in/out, and forwards user interactions back
 * to main via `canvas.user_response`.
 *
 * Lives in the second BrowserWindow created by `main/canvas.ts`. Pure
 * presentational — does not read or write the renderer state store.
 *
 * Slide animation tokens: docs/ux-design.md Pass 5 (spring-default).
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  CanvasIpcChannel,
  type CanvasDismissPayload,
  type CanvasRenderPayload,
} from '@shared/canvas-ipc';
import { Moodboard, type MoodboardProps } from './components/Moodboard';
import {
  ArtifactPreview,
  type ArtifactPreviewProps,
} from './components/ArtifactPreview';
import {
  HarnessRuleSave,
  type HarnessRuleSaveProps,
} from './components/HarnessRuleSave';
import { UnknownComponent } from './components/UnknownComponent';

type IpcRendererLike = {
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (
    channel: string,
    listener: (...args: unknown[]) => void,
  ) => void;
  send: (channel: string, ...args: unknown[]) => void;
};

function getIpc(): IpcRendererLike | null {
  const w = window as unknown as {
    electron?: { ipcRenderer?: IpcRendererLike };
    director?: { canvasIpc?: IpcRendererLike };
  };
  return w.electron?.ipcRenderer ?? w.director?.canvasIpc ?? null;
}

function isRenderPayload(value: unknown): value is CanvasRenderPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'component' in value &&
    typeof (value as { component: unknown }).component === 'string'
  );
}

function isDismissPayload(value: unknown): value is CanvasDismissPayload {
  return typeof value === 'object' && value !== null;
}

export function CanvasApp(): JSX.Element {
  const [current, setCurrent] = useState<CanvasRenderPayload | null>(null);
  const reducedMotion = useReducedMotion();
  // Track whether the active payload has already received a user_response
  // (or auto-fade completion) so we don't double-emit.
  const respondedRef = useRef<string | null>(null);

  useEffect(() => {
    const ipc = getIpc();
    if (!ipc) return;

    const onRender = (...args: unknown[]): void => {
      const payload = args.find(isRenderPayload);
      if (!payload) return;
      respondedRef.current = null;
      setCurrent(payload);
    };
    const onDismiss = (...args: unknown[]): void => {
      const payload = args.find(isDismissPayload);
      // If a component_id is given and doesn't match the current, ignore.
      if (
        payload?.component_id &&
        current &&
        current.component_id &&
        payload.component_id !== current.component_id
      ) {
        return;
      }
      setCurrent(null);
      respondedRef.current = null;
    };

    ipc.on(CanvasIpcChannel.Render, onRender);
    ipc.on(CanvasIpcChannel.Dismiss, onDismiss);
    return () => {
      ipc.removeListener(CanvasIpcChannel.Render, onRender);
      ipc.removeListener(CanvasIpcChannel.Dismiss, onDismiss);
    };
    // current is read inside onDismiss; closure captures fine because the
    // canvas window is single-payload at a time. Re-bind on each change.
  }, [current]);

  const respond = (value: unknown): void => {
    if (!current) return;
    const componentId = current.component_id ?? 'unknown';
    if (respondedRef.current === componentId) return;
    respondedRef.current = componentId;
    const ipc = getIpc();
    ipc?.send(CanvasIpcChannel.UserResponse, {
      component_id: componentId,
      value,
      call_id: current.call_id,
    });
  };

  // Auto-dismiss for ephemeral cards (harness_rule_save). When the timer
  // fires we emit a synthetic user_response so main can dismiss + log.
  useEffect(() => {
    if (!current?.autoDismissMs) return;
    const handle = window.setTimeout(() => {
      respond({ dismissed: true, reason: 'auto-fade' });
    }, current.autoDismissMs);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const slideIn = reducedMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { x: 32, opacity: 0 },
        animate: { x: 0, opacity: 1 },
        exit: { x: 24, opacity: 0 },
      };

  return (
    <div className="canvas-shell">
      <AnimatePresence mode="wait">
        {current ? (
          <motion.div
            key={current.component_id ?? current.component}
            className="canvas-stage"
            {...slideIn}
            transition={
              reducedMotion
                ? { duration: 0.12 }
                : { type: 'spring', stiffness: 180, damping: 22 }
            }
          >
            <CanvasBody payload={current} onRespond={respond} />
            <span className="canvas-mic-hint">or say it</span>
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            className="canvas-stage"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="canvas-empty">Canvas idle</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function CanvasBody({
  payload,
  onRespond,
}: {
  payload: CanvasRenderPayload;
  onRespond: (value: unknown) => void;
}): JSX.Element {
  switch (payload.component) {
    case 'moodboard':
      return (
        <Moodboard
          {...(payload.props as unknown as MoodboardProps)}
          onSelect={(conceptId) => onRespond({ concept_id: conceptId })}
        />
      );
    case 'artifact_preview':
      return (
        <ArtifactPreview
          {...(payload.props as unknown as ArtifactPreviewProps)}
          onAction={(action) => onRespond({ action })}
        />
      );
    // Accept both names while the contract settles — `harness_rule_save` is
    // the W3 tool-router spelling; `harness_flash` was the earlier name.
    case 'harness_rule_save':
    case 'harness_flash':
      return (
        <HarnessRuleSave
          {...(payload.props as unknown as HarnessRuleSaveProps)}
        />
      );
    default:
      return (
        <UnknownComponent
          component={payload.component}
          props={payload.props}
        />
      );
  }
}
