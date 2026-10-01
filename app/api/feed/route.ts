import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, GATED, fail } from "@/lib/api/envelope";
import { edgeFetch } from "@/lib/api/edge";

// GET /api/feed?cursor=&limit= — ranked (like-weight + recency + unseen-first).
// RLS returns only published + gated rows; ranking + impressions via be `feed` fn.
//
// THE GATE IS THE EDGE FUNCTION (ENG-1593). This route used to read the
// member's `subscription` row and run `hasAccess()` before forwarding — a
// second copy of a check the be `feed` function makes anyway, as its FIRST
// step, against the same row under the member's own RLS, and answers with 402.
// That copy cost a database round trip on every page. It is gone; the edge
// 402 below is what a lapsed member gets, and the relay is pinned by
// test/feed-route.test.ts.
//
// `getUser()` STAYS, deliberately (not `getClaims()`): it is the verified
// session check that turns a revoked single-device session into the 401 that
// `apiFetch` signs the tab out on (ENG-961). A local JWT check would keep an
// evicted tab reading the feed until its token expired.
export async function GET(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  // Explore never opts into Shares — for-sale posts are served only by
  // /api/feed/shares (ENG-831). Do not forward a client `shares=` here.
  const query = new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) });
  const res = await edgeFetch(sb, `feed?${query}`);
  if (res.status === 402) return GATED();
  if (res.status === 400) return fail("invalid_cursor", "Invalid cursor.", 400);
  if (!res.ok) return fail("feed_failed", "Could not load feed.", 502);
  const json = await res.json();
  return ok(json.data, json.meta);
}
