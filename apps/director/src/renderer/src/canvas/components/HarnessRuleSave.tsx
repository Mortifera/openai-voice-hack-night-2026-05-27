/**
 * HarnessRuleSave — ephemeral "Rule added" confirmation card.
 * Pencil source: Canvas / Harness Rule (cOQmdE).
 *
 * Visual: 480×220 card with plus-circle icon + "Rule added" eyebrow
 *         + rule text. Auto-fade ~1.2s (driver in CanvasApp).
 * Choreography: docs/ux-design.md Pass 3 §3B-1.
 */

import type { JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export interface HarnessRuleSaveProps {
  rule: string;
  why?: string;
}

export function HarnessRuleSave({
  rule,
  why,
}: HarnessRuleSaveProps): JSX.Element {
  const reduced = useReducedMotion();

  return (
    <motion.div
      className="rule-save"
      initial={reduced ? { opacity: 1 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={
        reduced
          ? { duration: 0.12 }
          : { duration: 0.32, ease: [0.32, 0.72, 0, 1] }
      }
    >
      <div className="rule-save-card" role="status">
        <div className="rule-save-icon" aria-hidden>
          +
        </div>
        <div className="rule-save-body">
          <span className="canvas-eyebrow">Rule added</span>
          <p className="rule-save-rule">{rule}</p>
          {why ? <span className="artifact-meta">{why}</span> : null}
        </div>
      </div>
    </motion.div>
  );
}
