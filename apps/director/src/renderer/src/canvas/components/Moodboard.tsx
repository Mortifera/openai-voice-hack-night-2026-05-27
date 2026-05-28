/**
 * Moodboard — 3-tile horizontal aesthetic chooser.
 * Pencil source: Canvas / Moodboard (Gb16Y).
 *
 * Interactive: click or voice → 500ms halo on selected tile, others dim.
 * Schema: docs/research/genui-schema.md §moodboard.
 * Interaction: docs/research/genui-interaction-modes.md "Per-component voice contracts".
 */

import { useState, type JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export interface MoodboardConcept {
  id: string;
  label: string;
  description: string;
  /** Resolved asset URL (e.g. via `new URL('./assets/foo.png', import.meta.url)`). */
  image_url: string;
  palette?: string[];
}

export interface MoodboardProps {
  title?: string;
  concepts: MoodboardConcept[];
  onSelect?: (conceptId: string) => void;
}

export function Moodboard({
  title,
  concepts,
  onSelect,
}: MoodboardProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const reduced = useReducedMotion();

  const handleSelect = (id: string): void => {
    if (selectedId) return; // Lock after first selection.
    setSelectedId(id);
    // Surface response after the resolution-halo animation completes.
    window.setTimeout(() => onSelect?.(id), reduced ? 0 : 500);
  };

  return (
    <div className="moodboard">
      {title ? <div className="canvas-title">{title}</div> : null}
      <div className="moodboard-grid">
        {concepts.map((concept) => {
          const isSelected = selectedId === concept.id;
          const isDimmed = selectedId !== null && !isSelected;
          return (
            <button
              key={concept.id}
              type="button"
              className={`moodboard-tile${isDimmed ? ' dimmed' : ''}`}
              data-no-drag
              onClick={() => handleSelect(concept.id)}
              aria-label={`${concept.label}: ${concept.description}`}
              aria-pressed={isSelected}
            >
              <div
                className="moodboard-tile-image"
                style={{ backgroundImage: `url(${concept.image_url})` }}
                aria-hidden
              />
              <div className="moodboard-tile-meta">
                <span className="moodboard-tile-label">{concept.label}</span>
                <span className="moodboard-tile-desc">
                  {concept.description}
                </span>
              </div>
              {isSelected ? (
                <motion.div
                  className="moodboard-tile-halo"
                  initial={
                    reduced
                      ? { opacity: 0 }
                      : { opacity: 0, scale: 0.94 }
                  }
                  animate={
                    reduced
                      ? { opacity: 1 }
                      : { opacity: [0, 1, 0.85], scale: [0.94, 1.04, 1.0] }
                  }
                  transition={{
                    duration: reduced ? 0.12 : 0.5,
                    ease: [0.32, 0.72, 0, 1],
                  }}
                />
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
