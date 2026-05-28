"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { Mixtape } from "@/lib/schema";
import CoverArt from "./CoverArt";
import TrackRow from "./TrackRow";

type Props = { mixtape: Mixtape };

function totalRuntime(tracks: Mixtape["tracks"]): string {
  const seconds = tracks.reduce((sum, t) => {
    const [m, s] = t.runtime.split(":").map((n) => parseInt(n, 10) || 0);
    return sum + m * 60 + s;
  }, 0);
  const mins = Math.floor(seconds / 60);
  return `${mins} min`;
}

function FakeShareQR() {
  // CSS-art "QR" — random-ish dot grid keyed by a small seed so it's static.
  const cells: boolean[] = [];
  let s = 0xa1b2c3;
  for (let i = 0; i < 169; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    cells.push((s & 0xff) > 110);
  }
  // Force the three position markers (corners) to be solid.
  for (let r = 0; r < 13; r++) {
    for (let c = 0; c < 13; c++) {
      const idx = r * 13 + c;
      const inCorner =
        (r < 3 && c < 3) ||
        (r < 3 && c > 9) ||
        (r > 9 && c < 3);
      const onCornerEdge =
        (r === 0 || r === 2) && c < 3 ||
        (c === 0 || c === 2) && r < 3 ||
        (r === 0 || r === 2) && c > 9 ||
        (c === 10 || c === 12) && r < 3 ||
        (r === 10 || r === 12) && c < 3 ||
        (c === 0 || c === 2) && r > 9;
      if (inCorner) {
        cells[idx] = onCornerEdge || (r === 1 && c === 1) || (r === 1 && c === 11) || (r === 11 && c === 1);
      }
    }
  }

  return (
    <div
      className="grid h-32 w-32 gap-[1px] rounded-md bg-[#0e0905] p-2"
      style={{ gridTemplateColumns: "repeat(13, 1fr)" }}
      aria-hidden
    >
      {cells.map((on, i) => (
        <div
          key={i}
          className="aspect-square"
          style={{ background: on ? "#C7A05A" : "transparent" }}
        />
      ))}
    </div>
  );
}

export default function PlaylistCard({ mixtape }: Props) {
  const [flipped, setFlipped] = useState(false);
  const reduced = useReducedMotion();

  return (
    <div className="flip-perspective w-[400px] max-w-full">
      <motion.button
        type="button"
        onClick={() => setFlipped((f) => !f)}
        aria-label={flipped ? "Show tracklist" : "Show back of card"}
        className="relative block w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-[#C7A05A] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1F140A]"
        style={{ transformStyle: "preserve-3d", borderRadius: 14 }}
        animate={reduced ? { rotateY: 0 } : { rotateY: flipped ? 180 : 0 }}
        transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 180, damping: 22 }}
      >
        {/* FRONT */}
        <div
          className="flip-face card-grain relative overflow-hidden p-5"
          style={{
            borderRadius: 14,
            background: "linear-gradient(170deg, rgba(82,62,32,0.92) 0%, rgba(48,34,18,0.92) 100%)",
            border: "1px solid rgba(199,160,90,0.28)",
            boxShadow:
              "0 18px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(199,160,90,0.10), inset 0 1px 0 rgba(255,210,150,0.10)",
          }}
        >
          <div
            className="overflow-hidden"
            style={{
              borderRadius: 10,
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08), 0 4px 16px rgba(0,0,0,0.4)",
            }}
          >
            <CoverArt vibe={mixtape.vibe} size={360} />
          </div>

          <div className="mt-4 flex items-baseline justify-between">
            <p className="text-[15px] font-medium leading-tight text-[#ECECF0]">{mixtape.vibe}</p>
            <span className="font-mono text-[11px] uppercase tracking-wider text-[rgba(199,160,90,0.85)]">
              {mixtape.tracks.length} tracks · {totalRuntime(mixtape.tracks)}
            </span>
          </div>

          <div className="mt-3 -mx-2">
            {mixtape.tracks.map((t, i) => (
              <TrackRow key={`${t.title}-${i}`} track={t} index={i} />
            ))}
          </div>

          <div className="mt-4 flex items-center justify-between text-[10px] uppercase tracking-widest text-[rgba(199,160,90,0.55)]">
            <span>Side A · Mixtape</span>
            <span className="font-mono">{mixtape.id}</span>
          </div>
        </div>

        {/* BACK */}
        <div
          className="flip-face card-grain absolute inset-0 flex flex-col items-center justify-between p-6"
          style={{
            borderRadius: 14,
            background: "linear-gradient(170deg, rgba(72,54,28,0.95) 0%, rgba(40,28,14,0.95) 100%)",
            border: "1px solid rgba(199,160,90,0.28)",
            boxShadow: "0 18px 50px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,210,150,0.10)",
            transform: "rotateY(180deg)",
          }}
        >
          <div className="w-full">
            <p className="text-[10px] uppercase tracking-[0.2em] text-[rgba(199,160,90,0.85)]">Mixtape</p>
            <h3 className="mt-1 text-[18px] font-medium leading-snug text-[#ECECF0]">{mixtape.vibe}</h3>
            <p className="mt-1 font-mono text-[11px] text-[rgba(236,236,240,0.50)]">
              {mixtape.tracks.length} tracks · {totalRuntime(mixtape.tracks)} runtime
            </p>
          </div>

          <FakeShareQR />

          <div className="w-full text-center">
            <a
              href={`#/m/${mixtape.id}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1.5 text-[13px] text-[#C7A05A] hover:text-[#e8c890]"
            >
              Pass the aux <span aria-hidden>↗</span>
            </a>
            <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-[rgba(199,160,90,0.45)]">
              tap card to flip
            </p>
          </div>
        </div>
      </motion.button>
    </div>
  );
}
