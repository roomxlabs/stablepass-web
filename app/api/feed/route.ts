import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, GATED, fail } from "@/lib/api/envelope";
import { hasAccess, ACCESS_COLUMNS } from "@/lib/api/access";
import { edgeFetch } from "@/lib/api/edge";

// GET /api/feed?cursor=&limit= — ranked (like-weight + recency + unseen-first).
// RLS returns only published + gated rows; ranking + impressions via be `feed` fn.
export async function GET(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const { data: sub } = await sb.from("subscription").select(ACCESS_COLUMNS).eq("user_id", user.id).single();
  if (!hasAccess(sub)) return GATED();
  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  const query = new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) });
  const res = await edgeFetch(sb, `feed?${query}`);
  if (res.status === 402) return GATED();
  if (res.status === 400) return fail("invalid_cursor", "Invalid cursor.", 400);
  if (!res.ok) return fail("feed_failed", "Could not load feed.", 502);
  const json = await res.json();
  return ok(json.data, json.meta);
}
