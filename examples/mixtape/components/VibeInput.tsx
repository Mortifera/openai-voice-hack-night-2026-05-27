"use client";

import { useState } from "react";
import type { Mixtape } from "@/lib/schema";

type Props = {
  onResult?: (mixtape: Mixtape) => void;
};

export default function VibeInput({ onResult }: Props) {
  const [vibe, setVibe] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Mixtape | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = vibe.trim();
    if (!trimmed || loading) return;
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
      onResult?.(mix);
    } catch (err) {
      setError(err instanceof Error ? err.message : "something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label htmlFor="vibe" className="text-xs uppercase tracking-widest text-[color:var(--color-text-dim)]">
          Describe the vibe
        </label>
        <input
          id="vibe"
          name="vibe"
          autoComplete="off"
          value={vibe}
          onChange={(e) => setVibe(e.target.value)}
          placeholder="late-night drive through tokyo neon"
          className="w-full rounded-xl border border-white/10 bg-[color:var(--color-surface)] px-4 py-3 text-base outline-none transition focus:border-[color:var(--color-accent)]"
        />
        <button
          type="submit"
          disabled={loading || !vibe.trim()}
          className="self-start rounded-xl bg-[color:var(--color-accent)] px-5 py-2.5 text-sm font-medium text-black transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Generating..." : "Generate"}
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </form>

      {result && (
        <div className="rounded-xl border border-white/10 bg-[color:var(--color-surface)] p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <div>
              <p className="text-xs uppercase tracking-widest text-[color:var(--color-text-dim)]">Vibe</p>
              <p className="text-base">{result.vibe}</p>
            </div>
            <p className="font-mono text-xs text-[color:var(--color-text-dim)]">{result.id}</p>
          </div>
          <ol className="divide-y divide-white/5">
            {result.tracks.map((t, i) => (
              <li key={`${t.title}-${i}`} className="flex items-baseline justify-between gap-4 py-2">
                <span className="w-6 text-xs text-[color:var(--color-text-dim)]">{String(i + 1).padStart(2, "0")}</span>
                <span className="flex-1">
                  <span className="block text-sm">{t.title}</span>
                  <span className="block text-xs text-[color:var(--color-text-dim)]">{t.artist}</span>
                </span>
                <span className="font-mono text-xs text-[color:var(--color-text-dim)]">{t.runtime}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-[color:var(--color-text-dim)]">
            Card UI (flip, cover art, hover waveform) is TODO — Maya wires it during the demo.
          </p>
        </div>
      )}
    </section>
  );
}
