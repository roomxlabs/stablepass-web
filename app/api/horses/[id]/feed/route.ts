// GET /api/horses/:id/feed — the horse-profile "Recent updates" list (W7,
// ENG-200). A DIRECT read of this horse's own published posts, chronological —
// unlike /api/feed this does NOT go through the be feed fn (no ranking/paging
// needed for a single horse's own timeline), so it works end-to-end against the
// local Postgres stack.
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

  // `aspect_ratio` is EXPLICIT here and must stay. Unlike /api/feed — which
  // proxies the be `feed` fn's `setof post` untouched — this route names its
  // columns, so a column omitted here simply never reaches the card and the
  // profile feed silently falls back to the unknown-ratio box. `sb` is untyped,
  // so `tsc` cannot catch that; test/horses-route.test.ts pins the column set.
  // This projection is load-bearing in BOTH directions, and BOTH failures are
  // silent (ENG-772). Too narrow: the column simply never reaches the card —
  // how `label` went missing here. Too wide: naming a column that is not
  // deployed makes PostgREST reject the WHOLE query with 42703 (HTTP 400) —
  // unlike `select *`, which would just omit it. That does NOT surface as a
  // 500: we destructure only `data` below, so `posts` is null, `ok(posts ?? [])`
  // returns 200 `{"data":[]}`, and both profile screens render "No updates yet"
  // — a total content blackout that looks exactly like an empty stable. So this
  // route must never name a column ahead of its migration (`label` needs
  // ENG-738's 20260819120001_post_label.sql, which is NOT yet on be `main`).
  const { data: posts } = await sb
    .from("post")
    .select("id, type, title, body, label, media_url, poster_url, mux_playback_id, aspect_ratio, watermarked, like_count, published_at, source_trainer_id")
    .eq("horse_id", id)
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(20);

  return ok(posts ?? []);
}
