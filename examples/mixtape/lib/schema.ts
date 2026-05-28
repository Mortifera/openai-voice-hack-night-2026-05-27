export type Track = {
  title: string;
  artist: string;
  runtime: string;
};

export type MixtapeTheme = "matte" | "cassette" | "holographic";

export type Mixtape = {
  id: string;
  vibe: string;
  tracks: Track[];
  theme: MixtapeTheme;
  createdAt: string;
};
