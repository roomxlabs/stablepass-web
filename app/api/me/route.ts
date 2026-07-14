// Account screen BFF (docs/specs/api-contract.md "GET/PATCH /api/me"; 09-account.html).
// Own row only — RLS `app_user_update_self` (id = auth.uid()) is the security
// boundary; the PATCH patch object below additionally never sets is_admin/email
// itself (a DB trigger blocks is_admin changes regardless, but we don't rely on
// that alone — the column is simply never in the patch we build).
import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";

type SubscriberRow = { name: string | null; email: string | null; phone: string | null };
type PrefsRow = {
  pref_new_post: boolean;
  pref_race_day: boolean;
  pref_race_result: boolean;
  pref_milestone: boolean;
};
type SubscriptionRow = { status: string; trial_ends_at: string | null; current_period_end: string | null };

function toPrefs(row: PrefsRow) {
  return {
    newPost: row.pref_new_post,
    raceDay: row.pref_race_day,
    raceResult: row.pref_race_result,
    milestone: row.pref_milestone,
  };
}

export async function GET() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const [{ data: subscriber }, { data: subscription }] = await Promise.all([
    sb.from("app_user")
      .select("name,email,phone,pref_new_post,pref_race_day,pref_race_result,pref_milestone")
      .eq("id", user.id).single(),
    sb.from("subscription").select("status,trial_ends_at,current_period_end").eq("user_id", user.id).single(),
  ]);

  const row = subscriber as (SubscriberRow & PrefsRow) | null;
  const sub = subscription as SubscriptionRow | null;

  return ok({
    subscriber: { name: row?.name ?? null, email: row?.email ?? null, phone: row?.phone ?? null },
    subscription: {
      status: sub?.status ?? null,
      trialEndsAt: sub?.trial_ends_at ?? null,
      currentPeriodEnd: sub?.current_period_end ?? null,
    },
    prefs: row
      ? toPrefs(row)
      : { newPost: true, raceDay: true, raceResult: true, milestone: true },
  });
}

export async function PATCH(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return fail("validation_failed", "Invalid request body.", 400);

  // Only ever populated from a fixed allow-list of columns below — is_admin and
  // email (Supabase Auth-owned) can never land in this object.
  const patch: Record<string, unknown> = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.phone === "string") patch.phone = body.phone;
  if (body.prefs && typeof body.prefs === "object") {
    const p = body.prefs as Record<string, unknown>;
    if (typeof p.newPost === "boolean") patch.pref_new_post = p.newPost;
    if (typeof p.raceDay === "boolean") patch.pref_race_day = p.raceDay;
    if (typeof p.raceResult === "boolean") patch.pref_race_result = p.raceResult;
    if (typeof p.milestone === "boolean") patch.pref_milestone = p.milestone;
  }
  if (!Object.keys(patch).length) return fail("validation_failed", "Nothing to update.", 400);

  const { data, error } = await sb.from("app_user").update(patch).eq("id", user.id)
    .select("name,email,phone,pref_new_post,pref_race_day,pref_race_result,pref_milestone").single();
  if (error) return fail("update_failed", error.message, 400);

  const row = data as SubscriberRow & PrefsRow;
  return ok({
    subscriber: { name: row.name, email: row.email, phone: row.phone },
    prefs: toPrefs(row),
  });
}
