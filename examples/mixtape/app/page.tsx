import VibeInput from "@/components/VibeInput";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-12 px-6 py-24">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Mixtape</h1>
        <p className="mt-2 text-sm text-[color:var(--color-text-dim)]">
          Speak a mood. Get a card. Demo target for Director.
        </p>
      </header>
      <VibeInput />
    </main>
  );
}
