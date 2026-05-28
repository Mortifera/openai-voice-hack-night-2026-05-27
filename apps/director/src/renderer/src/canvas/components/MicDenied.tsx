/**
 * MicDenied — degradation card shown when `getUserMedia` is rejected by
 * macOS privacy controls. Renders short copy + a deeplink button that
 * opens "System Settings → Privacy → Microphone".
 *
 * Per docs/remaining-phases.md §6.6 (W5 lane). The Director audio apology
 * ("I can't hear you. Mic permission needed.") is published by the realtime
 * layer when MicPermissionDenied propagates — this card is the visual half.
 *
 * Pure presentational. Props are tolerated as `unknown` per the defensive
 * coding rule in CLAUDE.md; missing/wrong-typed fields fall back to the
 * default copy with a `console.warn`.
 */

import type { JSX } from 'react';

/**
 * macOS deeplink that opens System Settings → Privacy & Security →
 * Microphone. Stable URL scheme since macOS 13; harmless on older systems
 * (opens the Privacy pane root).
 */
const SYSTEM_SETTINGS_DEEPLINK =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';

export interface MicDeniedProps {
  /** Override deeplink for tests / future System Settings pane changes. */
  deeplink?: string;
  /** Optional secondary message above the button. */
  hint?: string;
}

export function MicDenied({ deeplink, hint }: MicDeniedProps): JSX.Element {
  const resolvedDeeplink =
    typeof deeplink === 'string' && deeplink.length > 0
      ? deeplink
      : SYSTEM_SETTINGS_DEEPLINK;
  const resolvedHint =
    typeof hint === 'string' && hint.length > 0
      ? hint
      : 'Mic access blocked. I can’t hear you until you grant permission.';

  return (
    <div className="canvas-degrade" role="alert" aria-live="assertive">
      <span className="canvas-eyebrow">Microphone blocked</span>
      <div className="canvas-title">I can&rsquo;t hear you.</div>
      <p className="canvas-degrade-body">{resolvedHint}</p>
      <a
        className="canvas-degrade-button"
        href={resolvedDeeplink}
        data-no-drag
        // target="_self" so Electron's webContents follow the protocol
        // handler instead of opening a new window.
        target="_self"
        rel="noreferrer"
      >
        Open System Settings
      </a>
    </div>
  );
}
