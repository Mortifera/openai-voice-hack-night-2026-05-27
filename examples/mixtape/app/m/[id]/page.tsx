// TODO (Maya): share page rendering a saved Mixtape
//
// Director will dispatch Maya (Frontend) to build this during the demo.
// Expected behavior:
//   - Read the [id] param.
//   - Fetch the saved Mixtape via /api/mixtape/[id] (Jin's route).
//   - Render the hero PlaylistCard full-bleed (or stacked card+tracklist,
//     depending on the Canvas-time layout decision).
//   - Include an OG/share meta block so the URL previews nicely.

export default async function MixtapeSharePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <p className="text-xs uppercase tracking-widest text-[color:var(--color-text-dim)]">
        Share page placeholder
      </p>
      <h1 className="mt-2 text-2xl font-semibold">Mixtape {id}</h1>
      <p className="mt-4 text-sm text-[color:var(--color-text-dim)]">
        Maya finishes this route live during the Director demo.
      </p>
    </main>
  );
}
