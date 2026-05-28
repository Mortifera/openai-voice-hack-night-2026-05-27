import type { MixtapeTheme } from "@/lib/schema";

export type ThemeTokens = {
  surface: string;
  surfaceSolid: string;
  text: string;
  textDim: string;
  accent: string;
  border: string;
  shadowSoft: string;
};

export const themes: Record<MixtapeTheme, ThemeTokens> = {
  matte: {
    surface: "rgba(28, 28, 32, 0.78)",
    surfaceSolid: "#1c1c20",
    text: "#ECECF0",
    textDim: "rgba(236,236,240,0.55)",
    accent: "#9b9ba0",
    border: "rgba(255,255,255,0.08)",
    shadowSoft: "0 8px 32px rgba(0,0,0,0.45)",
  },
  cassette: {
    surface: "rgba(63, 47, 26, 0.80)",
    surfaceSolid: "#3F2F1A",
    text: "#ECECF0",
    textDim: "rgba(236,236,240,0.60)",
    accent: "#C7A05A",
    border: "rgba(199,160,90,0.22)",
    shadowSoft: "0 18px 50px rgba(0,0,0,0.55), 0 0 0 1px rgba(199,160,90,0.12)",
  },
  holographic: {
    surface: "rgba(40, 30, 60, 0.70)",
    surfaceSolid: "#28203c",
    text: "#ECECF0",
    textDim: "rgba(236,236,240,0.55)",
    accent: "#b8e0ff",
    border: "rgba(255,255,255,0.18)",
    shadowSoft: "0 12px 40px rgba(0,0,0,0.45)",
  },
};

export const cassette = themes.cassette;
