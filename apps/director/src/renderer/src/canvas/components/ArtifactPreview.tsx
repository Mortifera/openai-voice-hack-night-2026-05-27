/**
 * ArtifactPreview — final-reveal Mixtape card. Click cover to flip;
 * Ship / Iterate / Discard actions on the rear and the cover face.
 * Pencil source: Canvas / Artifact Preview (qoDBE).
 *
 * Schema: docs/research/genui-schema.md §artifact_preview.
 * Demo content: docs/research/demo-target-app.md "Mixtape".
 */

import { useState, type JSX } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export interface MixtapeTrack {
  title: string;
  artist: string;
  runtime: string;
}

export interface MixtapeData {
  vibe: string;
  tracks: MixtapeTrack[];
  coverUrl: string;
}

export interface ArtifactPreviewProps {
  title?: string;
  notes?: string;
  mixtape?: MixtapeData;
  actions?: Array<'ship' | 'iterate' | 'discard'>;
  onAction?: (action: 'ship' | 'iterate' | 'discard') => void;
}

/** Canonical Tokyo Neon demo mixtape — fake-but-believable synthwave roster. */
export const MOCK_MIXTAPE: MixtapeData = {
  vibe: 'late-night drive through Tokyo neon',
  tracks: [
    { title: 'Midnight Driver', artist: 'Akira Vance', runtime: '4:12' },
    { title: 'Velvet Apartment', artist: 'Noémie Hara', runtime: '3:48' },
    { title: 'Neon Rain', artist: 'Sable Sound', runtime: '5:02' },
    { title: 'Hyperreal', artist: 'Yoko & The Visa', runtime: '4:31' },
    { title: 'Lights From The Tower', artist: 'CHROMERIDER', runtime: '3:55' },
    { title: 'Akihabara Sunrise', artist: 'Aoi Tanaka', runtime: '4:24' },
  ],
  coverUrl: '',
};

export function ArtifactPreview({
  title,
  notes,
  mixtape = MOCK_MIXTAPE,
  actions = ['ship', 'iterate', 'discard'],
  onAction,
}: ArtifactPreviewProps): JSX.Element {
  const [flipped, setFlipped] = useState(false);
  const reduced = useReducedMotion();

  const totalRuntime = mixtape.tracks
    .reduce((sum, t) => {
      const [m, s] = t.runtime.split(':').map(Number);
      return sum + (m ?? 0) * 60 + (s ?? 0);
    }, 0);
  const totalMin = Math.floor(totalRuntime / 60);
  const totalSec = totalRuntime % 60;
  const totalStr = `${totalMin}:${String(totalSec).padStart(2, '0')}`;

  return (
    <div className="artifact">
      {title ? <div className="canvas-title">{title}</div> : null}

      <div className="artifact-frame">
        <motion.div
          className="artifact-card"
          animate={
            reduced ? { rotateY: 0 } : { rotateY: flipped ? 180 : 0 }
          }
          transition={
            reduced
              ? { duration: 0 }
              : { type: 'spring', stiffness: 180, damping: 22 }
          }
          style={{ transformStyle: 'preserve-3d' }}
        >
          {/* Front face — cover + tracklist. */}
          <div className="artifact-card-front">
            <button
              type="button"
              className="artifact-cover"
              data-no-drag
              onClick={() => setFlipped((f) => !f)}
              aria-label="Flip cover"
              style={{
                backgroundImage: mixtape.coverUrl
                  ? `url(${mixtape.coverUrl})`
                  : undefined,
              }}
            >
              <div className="artifact-cover-overlay">
                <span className="artifact-tag">Mixtape · {mixtape.tracks.length} tracks · {totalStr}</span>
                <span className="artifact-vibe">{mixtape.vibe}</span>
              </div>
            </button>

            <div className="artifact-tracks">
              {mixtape.tracks.map((track, i) => (
                <div className="artifact-track" key={`${track.title}-${i}`}>
                  <span className="artifact-track-num">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <div className="artifact-track-meta">
                    <span className="artifact-track-title">{track.title}</span>
                    <span className="artifact-track-artist">{track.artist}</span>
                  </div>
                  <span className="artifact-track-runtime">{track.runtime}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Back face — minimal meta + actions. */}
          <div className="artifact-card-back">
            <span className="canvas-eyebrow">Mixtape</span>
            <div className="canvas-title">{mixtape.vibe}</div>
            <span className="artifact-meta">
              {mixtape.tracks.length} tracks · {totalStr} runtime
            </span>
            {notes ? <span className="artifact-meta">{notes}</span> : null}
          </div>
        </motion.div>
      </div>

      {actions.length > 0 ? (
        <div className="artifact-actions">
          {actions.includes('ship') ? (
            <button
              type="button"
              className="artifact-action primary"
              data-no-drag
              onClick={() => onAction?.('ship')}
            >
              Ship
            </button>
          ) : null}
          {actions.includes('iterate') ? (
            <button
              type="button"
              className="artifact-action"
              data-no-drag
              onClick={() => onAction?.('iterate')}
            >
              Iterate
            </button>
          ) : null}
          {actions.includes('discard') ? (
            <button
              type="button"
              className="artifact-action danger"
              data-no-drag
              onClick={() => onAction?.('discard')}
            >
              Discard
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
