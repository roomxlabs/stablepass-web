import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, GATED, fail } from "@/lib/api/envelope";
import { edgeFetch } from "@/lib/api/edge";

// /api/posts/:id/playback — delegate to the be `playback` fn, which is the
// only place that mints a short-lived signed video URL. Re-gated there too.
// This route never holds a signing key: no video-provider signing happens here.
//
// Both GET and POST work (media-player POSTs; list screens GET). Optional
// posterOnly skips the stream mint and returns only the Storage poster for list render.
//
// ENG-1599 — `videoIndex` (query on GET, body on POST) names WHICH video of a
// multi-video post to mint, 0..4 by `post_video.sort_order` (ENG-1596). It is an
// ordinal, never an id or a path: the be resolves the row under the caller's own
// RLS. Omitted means 0 and is forwarded as omitted, so every pre-ENG-1599 caller
// sends the be byte-for-byte the body it always did.

/** The be's `MAX_VIDEO_INDEX` (supabase/functions/playback). Restated, not imported. */
const MAX_VIDEO_INDEX = 4;

const INVALID = Symbol("invalid");

/** A query-string index: digits only ("1", not "1.0", " 1" or "1e0"). */
function parseQueryIndex(raw: string | null): number | undefined | typeof INVALID {
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) return INVALID;
  const n = Number(raw);
  return n <= MAX_VIDEO_INDEX ? n : INVALID;
}

/** A body index: a JSON integer, exactly as the be's `parseVideoIndex` reads it. */
function parseBodyIndex(raw: unknown): number | undefined | typeof INVALID {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_VIDEO_INDEX) return INVALID;
  return raw;
}

async function handle(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  let posterOnly = false;
  let videoIndex: number | undefined | typeof INVALID;
  if (req.method === "GET") {
    const params = new URL(req.url).searchParams;
    posterOnly = params.get("posterOnly") === "1";
    videoIndex = parseQueryIndex(params.get("videoIndex"));
  } else {
    try {
      const body = await req.json();
      posterOnly = body?.posterOnly === true;
      videoIndex = parseBodyIndex(body?.videoIndex);
    } catch {
      // Empty / non-JSON body (media-player POST) → default playback mint.
    }
  }
  if (videoIndex === INVALID) {
    return fail("invalid_video_index", "videoIndex must be an integer 0..4.", 400);
  }

  const outbound: { postId: string; posterOnly?: true; videoIndex?: number } = { postId: id };
  if (posterOnly) outbound.posterOnly = true;
  if (videoIndex !== undefined) outbound.videoIndex = videoIndex;

  const res = await edgeFetch(sb, "playback", { method: "POST", body: outbound });
  if (res.status === 402) return GATED();
  if (res.status === 404) return fail("not_found", "No playable video.", 404);
  if (!res.ok) return fail("playback_failed", "Could not load playback.", 502);
  const json = await res.json();
  return ok(json.data);
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(req, ctx);
}
