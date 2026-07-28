// GET /api/horses/:id/feed — the horse-profile "Recent updates" list (W7,
// ENG-200). A DIRECT read of this horse's own published posts, chronological —
// unlike /api/feed this does NOT go through the be feed fn (no ranking/paging
// needed for a single horse's own timeline), so it works end-to-end against the
// local Postgres stack.
import { ok, UNAUTH, GATED } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { data: sub } = await sb.from("subscription").select("status").eq("user_id", user.id).single();
  if (!sub || !["trial", "active"].includes(sub.status)) return GATED();

  const { data: posts } = await sb
    .from("post")
    .select("id, type, title, body, media_url, poster_url, mux_playback_id, watermarked, like_count, published_at, source_trainer_id")
    .eq("horse_id", id)
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(20);

  return ok(posts ?? []);
}
