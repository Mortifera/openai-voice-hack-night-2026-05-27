/**
 * useStripDragHandle — toggles the Strip into a Canvas-window drag handle
 * while the Canvas is open.
 *
 * When canvas.open === true:
 *   - Sets `data-strip-drag="on"` on <html> so globals.css can switch the
 *     cursor to `grab` over the Strip surface.
 *   - The Strip overlay window inherits `-webkit-app-region: drag` on html
 *     already, so the user can drag the Strip window itself; the Canvas
 *     window follows via `main/canvas.ts` `setStripWindow` reposition.
 *
 * Spec: docs/remaining-phases.md § 5.3 ("Strip-as-Canvas-handle").
 *
 * The Strip BrowserWindow is created with `movable: false`
 * (apps/director/src/main/index.ts). This hook flips the window movable via
 * the `window.setStripMovable` IPC (gap 9) while the Canvas is open, and
 * back to non-movable on close, so the user can reposition the Strip (and
 * the Canvas follows) only during an active Canvas session.
 */

import { useEffect } from 'react';
import { useIsCanvasOpen } from '../state/selectors.js';

export function useStripDragHandle(): void {
  const canvasOpen = useIsCanvasOpen();
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    // ─── § renderer-wireup (gap 9) ──────────────────────────────────────
    // Toggle the underlying Strip window movable flag in main. Best-effort —
    // the bridge is absent in non-Electron contexts (tests, chat surface).
    const bridge = window.director;
    bridge?.windowControl?.setStripMovable({ movable: canvasOpen });
    if (canvasOpen) {
      html.dataset.stripDrag = 'on';
    } else {
      delete html.dataset.stripDrag;
    }
    return () => {
      delete html.dataset.stripDrag;
      // On unmount, restore the non-movable default.
      window.director?.windowControl?.setStripMovable({ movable: false });
    };
  }, [canvasOpen]);
}
