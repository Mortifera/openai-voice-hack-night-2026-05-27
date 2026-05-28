// TODO (Jin): GET/POST persisted mixtape via lib/store
//
// Director will dispatch Jin (Backend) to build this during the demo.
// Expected behavior:
//   - GET  /api/mixtape/[id]  -> 200 with Mixtape JSON, 404 if missing.
//   - POST /api/mixtape/[id]  -> upsert the supplied Mixtape, return it.
// Persistence layer is Cleo's lib/store (file-backed JSON in data/mixtapes.json).

import { NextResponse } from "next/server";

// Next.js 15: route params arrive as a Promise.
type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  return NextResponse.json(
    { error: `mixtape ${id} lookup not implemented yet (Jin TODO)` },
    { status: 501 },
  );
}

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  return NextResponse.json(
    { error: `mixtape ${id} persistence not implemented yet (Jin TODO)` },
    { status: 501 },
  );
}
