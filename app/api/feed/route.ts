import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, GATED } from "@/lib/api/envelope";

// GET /api/feed?cursor=&limit= — ranked (like-weight + recency + unseen-first).
// RLS returns only published + gated rows; ranking + impressions via be `feed` fn.
export async function GET(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const { data: sub } = await sb.from("subscription").select("status").eq("user_id", user.id).single();
  if (!sub || !["trial", "active"].includes(sub.status)) return GATED();
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 50);
  // TODO(ticket): invoke be edge fn `feed` for ranking + impression recording.
  void limit;
  return ok([], { nextCursor: null, hasMore: false });
}
