"use client";

type Props = { vibe: string; size?: number };

type Palette = {
  bgFrom: string;
  bgTo: string;
  blobA: string;
  blobB: string;
  blobC: string;
  line: string;
  grain: string;
};

const PALETTES: Record<string, Palette> = {
  neon: {
    bgFrom: "#1a0b2e",
    bgTo: "#0a0a14",
    blobA: "#ff2bd6",
    blobB: "#22d3ee",
    blobC: "#7c3aed",
    line: "#ff6bd6",
    grain: "rgba(255, 107, 214, 0.18)",
  },
  lofi: {
    bgFrom: "#2a1f14",
    bgTo: "#14100a",
    blobA: "#e0a36b",
    blobB: "#c97f5a",
    blobC: "#8a5d3a",
    line: "#f0c896",
    grain: "rgba(240, 200, 150, 0.15)",
  },
  jazz: {
    bgFrom: "#1c1207",
    bgTo: "#0d0703",
    blobA: "#c79454",
    blobB: "#a85a3a",
    blobC: "#5a2a18",
    line: "#e8b878",
    grain: "rgba(232, 184, 120, 0.12)",
  },
  ambient: {
    bgFrom: "#0a1a24",
    bgTo: "#020812",
    blobA: "#5a8ab8",
    blobB: "#7ab4c8",
    blobC: "#3a5878",
    line: "#a8d4e8",
    grain: "rgba(168, 212, 232, 0.12)",
  },
  indie: {
    bgFrom: "#1f1a12",
    bgTo: "#0e0c08",
    blobA: "#d8a85e",
    blobB: "#a47a4a",
    blobC: "#604628",
    line: "#f0d090",
    grain: "rgba(216, 168, 94, 0.12)",
  },
  electronic: {
    bgFrom: "#0a0a18",
    bgTo: "#000008",
    blobA: "#3affc6",
    blobB: "#2a8aff",
    blobC: "#7a3aff",
    line: "#5af0c8",
    grain: "rgba(90, 240, 200, 0.14)",
  },
  soul: {
    bgFrom: "#1a0a0a",
    bgTo: "#0a0303",
    blobA: "#d86a4a",
    blobB: "#b04030",
    blobC: "#7a2818",
    line: "#f0a070",
    grain: "rgba(240, 160, 112, 0.12)",
  },
  folk: {
    bgFrom: "#14180c",
    bgTo: "#06080a",
    blobA: "#9aa86a",
    blobB: "#c8a878",
    blobC: "#5a6840",
    line: "#d8c898",
    grain: "rgba(216, 200, 152, 0.12)",
  },
  default: {
    bgFrom: "#1a1410",
    bgTo: "#0a0806",
    blobA: "#c7a05a",
    blobB: "#8a6438",
    blobC: "#5a3a1a",
    line: "#e8c890",
    grain: "rgba(232, 200, 144, 0.12)",
  },
};

function pickPalette(vibe: string): Palette {
  const lower = vibe.toLowerCase();
  if (/(neon|tokyo|cyber|vapor|synthwave|night.*drive|miami)/.test(lower)) return PALETTES.neon;
  if (/(lofi|lo-fi|study|coffee|chill|sunday|espresso|morning)/.test(lower)) return PALETTES.lofi;
  if (/(jazz|saxophone|bossa|noir|smoky|bar|whiskey)/.test(lower)) return PALETTES.jazz;
  if (/(ambient|drone|slow|glacial|snow|fog|sleep|calm|spacious)/.test(lower)) return PALETTES.ambient;
  if (/(indie|bedroom|porch|earnest|diary)/.test(lower)) return PALETTES.indie;
  if (/(electronic|techno|club|warehouse|berlin|dance|modular)/.test(lower)) return PALETTES.electronic;
  if (/(soul|motown|gospel|sunday|brass|funk|groove)/.test(lower)) return PALETTES.soul;
  if (/(folk|acoustic|cabin|country|winter|fire)/.test(lower)) return PALETTES.folk;
  return PALETTES.default;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export default function CoverArt({ vibe, size = 280 }: Props) {
  const palette = pickPalette(vibe);
  const seed = hash(vibe);
  const r = rng(seed);

  const blobs = Array.from({ length: 3 }, (_, i) => ({
    cx: 30 + r() * 240,
    cy: 30 + r() * 240,
    rad: 90 + r() * 90,
    color: [palette.blobA, palette.blobB, palette.blobC][i],
  }));

  const lines = Array.from({ length: 5 }, () => {
    const y1 = r() * 300;
    const y2 = r() * 300;
    return { x1: -20, x2: 320, y1, y2, w: 0.5 + r() * 1.5, o: 0.15 + r() * 0.35 };
  });

  const id = (seed % 100000).toString();

  return (
    <svg
      viewBox="0 0 300 300"
      width={size}
      height={size}
      role="img"
      aria-label={`abstract cover art for ${vibe}`}
      style={{ display: "block", borderRadius: 10 }}
    >
      <defs>
        <linearGradient id={`bg-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={palette.bgFrom} />
          <stop offset="100%" stopColor={palette.bgTo} />
        </linearGradient>
        {blobs.map((b, i) => (
          <radialGradient key={i} id={`blob-${id}-${i}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor={b.color} stopOpacity="0.85" />
            <stop offset="100%" stopColor={b.color} stopOpacity="0" />
          </radialGradient>
        ))}
        <filter id={`blur-${id}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="22" />
        </filter>
        <filter id={`grain-${id}`}>
          <feTurbulence baseFrequency="0.9" numOctaves="2" seed={seed % 100} />
          <feColorMatrix
            values={`0 0 0 0 1   0 0 0 0 1   0 0 0 0 1   0 0 0 0.18 0`}
          />
          <feComposite operator="in" in2="SourceGraphic" />
        </filter>
      </defs>

      <rect width="300" height="300" fill={`url(#bg-${id})`} />

      <g filter={`url(#blur-${id})`}>
        {blobs.map((b, i) => (
          <circle
            key={i}
            cx={b.cx}
            cy={b.cy}
            r={b.rad}
            fill={`url(#blob-${id}-${i})`}
          />
        ))}
      </g>

      <g opacity="0.55">
        {lines.map((l, i) => (
          <line
            key={i}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke={palette.line}
            strokeWidth={l.w}
            strokeOpacity={l.o}
          />
        ))}
      </g>

      <rect
        width="300"
        height="300"
        fill={palette.grain}
        filter={`url(#grain-${id})`}
        style={{ mixBlendMode: "overlay" }}
      />

      <rect
        width="300"
        height="300"
        fill="none"
        stroke="rgba(255,255,255,0.08)"
        strokeWidth="1"
        rx="10"
      />
    </svg>
  );
}
