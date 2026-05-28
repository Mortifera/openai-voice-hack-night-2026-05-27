/**
 * Renderer-side helper: render a `WorldStateBrief` as the plain-text
 * `system`-role conversation item Session_B receives at rotation time.
 *
 * Kept here (and not in `main/world-state-brief.ts`) because the renderer
 * can't import from main/. The format is identical — the main-side helper
 * is the source of truth for tests; this is a faithful re-implementation
 * so the data path renderer → Session_B doesn't have to round-trip
 * through main just to stringify.
 *
 * If you change the format, change BOTH this file and
 * `apps/director/src/main/world-state-brief.ts` together, and update the
 * vitest assertions in `world-state-brief.test.ts`.
 */

import type { WorldStateBrief } from '../../../shared/state.js';

function safe(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

export function renderBriefAsSystemText(brief: WorldStateBrief): string {
  const lines: string[] = [];
  lines.push('# Director — session rotation brief');
  lines.push(
    `Continuing from a prior Realtime session (~${Math.round(
      brief.elapsedMs / 1000,
    )}s elapsed). Treat the items below as established context.`,
  );

  if (brief.goal) {
    lines.push('', '## Current goal', brief.goal);
  }

  if (brief.harnessRules.length > 0) {
    lines.push('', '## Active harness rules (verbatim, must honor)');
    for (const rule of brief.harnessRules) lines.push(`- ${rule}`);
  }

  if (brief.activeAgents.length > 0) {
    lines.push('', '## Active sub-agents');
    for (const a of brief.activeAgents) {
      const task = a.task ? ` — ${a.task}` : '';
      lines.push(`- ${a.name} (${a.role}, ${a.status})${task}`);
    }
  }

  if (brief.lastCanvas) {
    lines.push(
      '',
      '## Last Canvas',
      `${brief.lastCanvas.component}${
        brief.lastCanvas.awaitingResponse ? ' (awaiting user response)' : ''
      }`,
    );
  }

  if (brief.recentTranscript.length > 0) {
    lines.push('', '## Recent turns (oldest first)');
    for (const item of brief.recentTranscript) {
      const content = safe(item.content).replace(/\n+/g, ' ').trim();
      lines.push(`- [${item.role}] ${content}`);
    }
  }

  return lines.join('\n');
}
