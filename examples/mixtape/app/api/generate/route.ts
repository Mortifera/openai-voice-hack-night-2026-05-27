import { NextResponse } from "next/server";
import type { Mixtape } from "@/lib/schema";
import { pickTracksForVibe } from "@/lib/mockTracks";
import { shortId } from "@/lib/id";

export const runtime = "nodejs";

type GenerateBody = { vibe?: unknown };

export async function POST(req: Request) {
  let body: GenerateBody;
  try {
    body = (await req.json()) as GenerateBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const vibe = typeof body.vibe === "string" ? body.vibe.trim() : "";
  if (!vibe) {
    return NextResponse.json({ error: "vibe is required" }, { status: 400 });
  }

  const mixtape: Mixtape = {
    id: shortId(),
    vibe,
    tracks: pickTracksForVibe(vibe, 8),
    theme: "matte",
    createdAt: new Date().toISOString(),
  };

  return NextResponse.json(mixtape);
}
