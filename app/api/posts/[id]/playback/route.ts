import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, GATED, fail } from "@/lib/api/envelope";
import { edgeFetch } from "@/lib/api/edge";

// GET /api/posts/:id/playback — delegate to the be `playback` fn, which is the
// only place that mints a short-lived signed video URL. Re-gated there too.
// This route never holds a signing key: no video-provider signing happens here.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const res = await edgeFetch(sb, "playback", { method: "POST", body: { postId: id } });
  if (res.status === 402) return GATED();
  if (res.status === 404) return fail("not_found", "No playable video.", 404);
  if (!res.ok) return fail("playback_failed", "Could not load playback.", 502);
  const json = await res.json();
  return ok(json.data);
}
