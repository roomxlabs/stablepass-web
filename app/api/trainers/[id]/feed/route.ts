// GET /api/trainers/:id/feed — the trainer-profile "Recent updates" list (W8,
// ENG-201). A DIRECT read of this trainer's own published posts (source_trainer_id),
// chronological — unlike /api/feed this does NOT go through the be feed fn, so it
// works end-to-end against the local Postgres stack. Each post carries its horse's
// name so the byline is per-horse (a trainer's updates span their whole stable).
import { ok, UNAUTH, GATED } from "@/lib/api/envelope";
import { hasAccess, ACCESS_COLUMNS } from "@/lib/api/access";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { data: sub } = await sb.from("subscription").select(ACCESS_COLUMNS).eq("user_id", user.id).single();
  if (!hasAccess(sub)) return GATED();

  const { data: posts } = await sb
    .from("post")
    .select("id, type, title, body, media_url, poster_url, mux_playback_id, watermarked, like_count, published_at, horse_id, horse:horse_id(display_name, racing_name)")
    .eq("source_trainer_id", id)
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(20);

  return ok(posts ?? []);
}
