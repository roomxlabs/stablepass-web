import { ok, UNAUTH } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";
export async function GET() {
  const sb = await supabaseServer(); const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  // TODO(ticket): ranked feed restricted to followed trainers/horses.
  return ok([], { nextCursor: null, hasMore: false });
}
