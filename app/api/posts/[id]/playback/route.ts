import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, GATED, fail } from "@/lib/api/envelope";
import { edgeFetch } from "@/lib/api/edge";

// /api/posts/:id/playback — delegate to the be `playback` fn, which is the
// only place that mints a short-lived signed video URL. Re-gated there too.
// This route never holds a signing key: no video-provider signing happens here.
//
// Both GET and POST work (media-player POSTs; list screens GET). Optional
// posterOnly skips the stream mint and returns only the Storage poster for list render.
async function handle(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  let posterOnly = false;
  if (req.method === "GET") {
    posterOnly = new URL(req.url).searchParams.get("posterOnly") === "1";
  } else {
    try {
      const body = await req.json();
      posterOnly = body?.posterOnly === true;
    } catch {
      // Empty / non-JSON body (media-player POST) → default playback mint.
    }
  }

  const res = await edgeFetch(sb, "playback", {
    method: "POST",
    body: posterOnly ? { postId: id, posterOnly: true } : { postId: id },
  });
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
