import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH } from "@/lib/api/envelope";
// POST /api/auth/bootstrap — ensure app_user + trial subscription after first
// social login. Idempotent; the DB trigger handle_new_user() is the primary path.
export async function POST() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const { data: subscriber } = await sb.from("app_user").select("id,name,email").eq("id", user.id).maybeSingle();
  const { data: subscription } = await sb.from("subscription").select("status,trial_ends_at").eq("user_id", user.id).maybeSingle();
  return ok({ subscriber, subscription });
}
