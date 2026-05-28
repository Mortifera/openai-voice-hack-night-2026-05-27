"use client";

import { useEffect, useRef, useState } from "react";
import type { Mixtape } from "@/lib/schema";
import PlaylistCard from "./PlaylistCard";

type Props = {
  initialVibe?: string;
  autoSubmit?: boolean;
};

export default function VibeInput({ initialVibe = "", autoSubmit = false }: Props) {
  const [vibe, setVibe] = useState(initialVibe);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Mixtape | null>(null);
  const autoFiredRef = useRef(false);

  async function generate(rawVibe: string) {
    const trimmed = rawVibe.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vibe: trimmed }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(detail || `request failed: ${res.status}`);
      }
      const mix = (await res.json()) as Mixtape;
      setResult(mix);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (autoSubmit && initialVibe && !autoFiredRef.current) {
      autoFiredRef.current = true;
      void generate(initialVibe);
    }
  }, [autoSubmit, initialVibe]);

  if (result) {
    return (
      <div className="flex flex-col items-center gap-6">
        <PlaylistCard mixtape={result} />
        <button
          type="button"
          onClick={() => {
            setResult(null);
            setVibe("");
          }}
          className="text-[12px] uppercase tracking-widest text-[rgba(199,160,90,0.6)] hover:text-[#C7A05A]"
        >
          Another vibe
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!loading) void generate(vibe);
      }}
      className="flex flex-col gap-3"
    >
      <label htmlFor="vibe" className="text-[11px] uppercase tracking-[0.18em] text-[rgba(199,160,90,0.75)]">
        Describe the vibe
      </label>
      <input
        id="vibe"
        name="vibe"
        autoComplete="off"
        value={vibe}
        onChange={(e) => setVibe(e.target.value)}
        placeholder="late-night drive through tokyo neon"
        className="w-full rounded-xl border border-[rgba(199,160,90,0.25)] bg-[rgba(63,47,26,0.6)] px-4 py-3 text-base text-[#ECECF0] placeholder:text-[rgba(236,236,240,0.35)] outline-none transition focus:border-[#C7A05A]"
      />
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading || !vibe.trim()}
          className="rounded-xl bg-[#C7A05A] px-5 py-2.5 text-sm font-medium text-[#1F140A] transition hover:bg-[#d4ae66] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Generating..." : "Generate"}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    </form>
  );
}
