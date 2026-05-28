"use client";

import type { Track } from "@/lib/schema";

type Props = { track: Track; index: number };

const BARS = [0.4, 0.7, 1.0, 0.55, 0.85, 0.3, 0.75, 0.45, 0.9, 0.5];

export default function TrackRow({ track, index }: Props) {
  return (
    <div className="group relative grid grid-cols-[28px_1fr_auto] items-center gap-3 rounded-md px-3 py-2.5 transition-colors duration-150 hover:bg-[rgba(199,160,90,0.08)]">
      <span className="font-mono text-[11px] tracking-tight text-[rgba(236,236,240,0.40)]">
        {String(index + 1).padStart(2, "0")}
      </span>

      <div className="min-w-0">
        <div className="truncate text-[14px] leading-tight text-[#ECECF0]">{track.title}</div>
        <div className="truncate text-[12px] leading-tight text-[rgba(236,236,240,0.55)]">{track.artist}</div>
      </div>

      <div className="relative flex h-5 items-center justify-end">
        <span className="font-mono text-[11px] text-[rgba(236,236,240,0.55)] transition-opacity duration-150 group-hover:opacity-0">
          {track.runtime}
        </span>
        <svg
          viewBox="0 0 50 16"
          width="50"
          height="16"
          aria-hidden
          className="pointer-events-none absolute right-0 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        >
          {BARS.map((h, i) => (
            <rect
              key={i}
              x={i * 5}
              y={(1 - h) * 8}
              width="3"
              height={h * 16}
              rx="1"
              fill="#C7A05A"
              opacity={0.5 + h * 0.5}
            >
              <animate
                attributeName="height"
                values={`${h * 16};${(1 - h) * 16};${h * 16}`}
                dur={`${0.7 + (i % 3) * 0.2}s`}
                repeatCount="indefinite"
              />
              <animate
                attributeName="y"
                values={`${(1 - h) * 8};${h * 8};${(1 - h) * 8}`}
                dur={`${0.7 + (i % 3) * 0.2}s`}
                repeatCount="indefinite"
              />
            </rect>
          ))}
        </svg>
      </div>
    </div>
  );
}
