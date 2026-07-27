import { noContent, UNAUTH, fail } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";

// POST /api/feed/seen — batch-record impressions for postIds (own rows, RLS-scoped).
export async function POST(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const { postIds } = await req.json();
  if (!Array.isArray(postIds) || postIds.length === 0 || !postIds.every((id) => typeof id === "string")) {
    return fail("validation_failed", "postIds[] required", 400);
  }
  const { error } = await sb
    .from("impression")
    .insert(postIds.map((post_id: string) => ({ user_id: user.id, post_id })));
  if (error) {
    // Best-effort: duplicate/insert errors don't block the client from moving past seen posts.
    console.error("feed/seen insert failed", error);
  }
  return noContent();
}
