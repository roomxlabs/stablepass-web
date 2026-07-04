import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, GATED, fail } from "@/lib/api/envelope";
// GET /api/posts/:id/playback — mint short-lived Mux signed URL; re-check gate.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const { data: sub } = await sb.from("subscription").select("status").eq("user_id", user.id).single();
  if (!sub || !["trial", "active"].includes(sub.status)) return GATED();
  const { data: post } = await sb.from("post").select("id,mux_playback_id,status").eq("id", id).single();
  if (!post?.mux_playback_id) return fail("not_found", "No playable video.", 404);
  // TODO(ticket): sign a short-lived Mux playback token; return playbackUrl + expiresAt.
  return ok({ playbackUrl: null, expiresAt: null });
}
