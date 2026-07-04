import { noContent, UNAUTH } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";
export async function POST(req: Request) {
  const sb = await supabaseServer(); const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const { postIds } = await req.json();
  // TODO(ticket): batch-insert impressions for postIds (own rows).
  void postIds; return noContent();
}
