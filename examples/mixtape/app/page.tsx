import VibeInput from "@/components/VibeInput";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ vibe?: string }>;

export default async function Home({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const initialVibe = typeof sp?.vibe === "string" ? sp.vibe : "";
  const autoSubmit = initialVibe.trim().length > 0;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center gap-12 px-6 py-16">
      <header className="self-stretch text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-[rgba(199,160,90,0.7)]">Mixtape</p>
        <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-[#ECECF0]">
          Vibe in. Tape out.
        </h1>
      </header>

      <VibeInput initialVibe={initialVibe} autoSubmit={autoSubmit} />
    </main>
  );
}
