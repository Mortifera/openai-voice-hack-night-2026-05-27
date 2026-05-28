/**
 * Canvas root — routes `canvas.show` IPC events to the matching GenUI
 * component (moodboard / artifact_preview / harness_flash / …). Lives in the
 * second BrowserWindow created by `main/canvas.ts`. Pure presentational —
 * does not touch the renderer state store.
 *
 * Slide-in / dismiss animations: AnimatePresence + a single shared frame.
 * docs/ux-design.md Pass 1 (Canvas slides leftward from right edge),
 * Pass 5 (radius, shadow, motion tokens).
 */

import { useEffect, useState, type JSX } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  CanvasIpcChannel,
  type CanvasShowPayload,
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

type IpcRendererLike = {
  on: (channel: string, listener: (...args: unknown[]) => void) => void;
  removeListener: (
    channel: string,
    listener: (...args: unknown[]) => void,
  ) => void;
  send: (channel: string, ...args: unknown[]) => void;
};

/** Minimal IPC handle exposed by preload (W1 owns the bridge). */
function getIpc(): IpcRendererLike | null {
  // electron preload exposes ipcRenderer when contextIsolation is on; we also
  // tolerate dev-mode browsers where it's missing.
  const w = window as unknown as {
    electron?: { ipcRenderer?: IpcRendererLike };
    director?: { canvasIpc?: IpcRendererLike };
  };
  return w.electron?.ipcRenderer ?? w.director?.canvasIpc ?? null;
}

export function CanvasApp(): JSX.Element {
  const [current, setCurrent] = useState<CanvasShowPayload | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const ipc = getIpc();
    if (!ipc) return;

    const onShow = (...args: unknown[]): void => {
      // electron passes (event, ...payload). Find the first object arg.
      const payload = args.find(
        (arg): arg is CanvasShowPayload =>
          typeof arg === 'object' && arg !== null && 'component' in arg,
      );
      if (payload) setCurrent(payload);
    };
    const onDismiss = (): void => setCurrent(null);

    ipc.on(CanvasIpcChannel.Show, onShow);
    ipc.on(CanvasIpcChannel.Dismiss, onDismiss);
    return () => {
      ipc.removeListener(CanvasIpcChannel.Show, onShow);
      ipc.removeListener(CanvasIpcChannel.Dismiss, onDismiss);
    };
  }, []);

  // Auto-dismiss timer for ephemeral cards (harness_flash).
  useEffect(() => {
    if (!current?.autoDismissMs) return;
    const handle = window.setTimeout(() => {
      setCurrent(null);
      const ipc = getIpc();
      ipc?.send(CanvasIpcChannel.Close);
    }, current.autoDismissMs);
    return () => window.clearTimeout(handle);
  }, [current]);

  const respond = (value: unknown): void => {
    if (!current) return;
    const ipc = getIpc();
    ipc?.send(CanvasIpcChannel.Response, {
      componentId: current.componentId,
      value,
    });
  };

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
            key={current.componentId}
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
  payload: CanvasShowPayload;
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
    case 'harness_flash':
      return (
        <HarnessRuleSave
          {...(payload.props as unknown as HarnessRuleSaveProps)}
        />
      );
    default:
      return (
        <div className="canvas-empty">
          {`No renderer for: ${payload.component}`}
        </div>
      );
  }
}
