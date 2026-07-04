import { ok, UNAUTH } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";
export async function POST() {
  const sb = await supabaseServer(); const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  // TODO(ticket): create a SetupIntent; return clientSecret for inline card update.
  return ok({ clientSecret: "seti_todo" });
}
