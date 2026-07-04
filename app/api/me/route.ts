import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";

export async function GET() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const [{ data: subscriber }, { data: subscription }] = await Promise.all([
    sb.from("app_user").select("id,name,email,phone,is_admin,pref_new_post,pref_race_day,pref_race_result,pref_milestone").eq("id", user.id).single(),
    sb.from("subscription").select("status,trial_ends_at,current_period_end").eq("user_id", user.id).single(),
  ]);
  const prefs = subscriber && {
    newPost: subscriber.pref_new_post, raceDay: subscriber.pref_race_day,
    raceResult: subscriber.pref_race_result, milestone: subscriber.pref_milestone,
  };
  return ok({ subscriber, subscription, prefs });
}

export async function PATCH(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const body = await req.json();
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.phone === "string") patch.phone = body.phone;
  if (body.prefs) {
    const p = body.prefs;
    if ("newPost" in p) patch.pref_new_post = !!p.newPost;
    if ("raceDay" in p) patch.pref_race_day = !!p.raceDay;
    if ("raceResult" in p) patch.pref_race_result = !!p.raceResult;
    if ("milestone" in p) patch.pref_milestone = !!p.milestone;
  }
  if (!Object.keys(patch).length) return fail("validation_failed", "Nothing to update.", 400);
  const { data, error } = await sb.from("app_user").update(patch).eq("id", user.id)
    .select("id,name,phone,pref_new_post,pref_race_day,pref_race_result,pref_milestone").single();
  if (error) return fail("update_failed", error.message, 400);
  return ok({ subscriber: data });
}
