// GET /api/horses/:id/feed — the horse-profile "Recent updates" list (W7,
// ENG-200). A DIRECT read of this horse's own published posts, chronological —
// unlike /api/feed this does NOT go through the be feed fn (no ranking needed
// for a single horse's own timeline; paged by `?cursor=` since ENG-1633), so it
// works end-to-end against the
// local Postgres stack.
import { ok, fail, UNAUTH, GATED } from "@/lib/api/envelope";
import { hasAccess, ACCESS_COLUMNS } from "@/lib/api/access";
import { POST_INTRINSIC_COLUMNS } from "@/lib/feed/post-row";
import { PROFILE_FEED_PAGE_SIZE, parseProfileCursor, profileCursorFilter, profileFeedMeta } from "@/lib/feed/profile-cursor";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { data: sub } = await sb.from("subscription").select(ACCESS_COLUMNS).eq("user_id", user.id).single();
  if (!hasAccess(sub)) return GATED();

  // ENG-1633 — `?cursor=` pages (the contract's shape): the last row's
  // `<published_at>|<id>` keyset, both halves validated (ISO / UUID) before
  // they reach a filter. Absent = page 1.
  const cursor = parseProfileCursor(new URL(req.url).searchParams.get("cursor"));
  if (cursor === undefined) return fail("invalid_cursor", "cursor is malformed.", 400);

  // The post columns come from the ONE shared constant (ENG-794) — the same
  // trick as `ACCESS_COLUMNS`, and the reason a new `post` column is now one
  // edit rather than five. `source_trainer_id` is this route's own context
  // column and stays here. Why the constant is load-bearing in BOTH directions
  // (too narrow silently starves the card; too wide fails 42703 and blanks the
  // whole feed) is documented on it in lib/feed/post-row.ts. Never name a
  // column ahead of its migration: `label` needs ENG-738's
  // 20260819120001_post_label.sql, which is NOT yet on be `main`.
  // test/horses-route.test.ts still pins the resolved string exactly.
  let query = sb
    .from("post")
    .select(POST_INTRINSIC_COLUMNS)
    .eq("horse_id", id)
    .eq("status", "published");
  if (cursor) query = query.or(profileCursorFilter(cursor));
  const { data: posts, error } = await query
    .order("published_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PROFILE_FEED_PAGE_SIZE);

  // A rejected read (e.g. a filter PostgREST refused) is a 5xx, never an empty
  // page with `hasMore: false` — that would silently end the list (ENG-1633).
  if (error) return fail("feed_failed", "Couldn't load these updates.", 500);

  const rows = (posts ?? []) as { id?: string | null; published_at?: string | null }[];
  return ok(rows, profileFeedMeta(rows));
}
