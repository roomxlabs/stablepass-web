// Account screen (09-account.html, MINUS Devices & sessions — single-device
// guardrail, .rx/guardrails.md #5: no devices/sessions UI, just Sign out).
// Server component under the (member) shell (auth already guarded by
// app/(member)/layout.tsx). Reads the same subscriber/subscription/prefs shape
// as GET /api/me directly via supabaseServer, avoiding an internal fetch — same
// pattern as the W7 horse-profile page. The Subscription card is static (its
// CTA just links to /checkout; W10 owns the real billing flow). The Profile +
// Notifications forms and Sign out are the interactive AccountForms island.
import { supabaseServer } from "@/lib/supabase/server";
import { AccountForms, type AccountPrefs, type AccountSubscriber } from "./account-forms";

export const metadata = { title: "Account · StablePass" };

type SubscriberRow = { name: string | null; email: string | null; phone: string | null };
type PrefsRow = {
  pref_new_post: boolean;
  pref_race_day: boolean;
  pref_race_result: boolean;
  pref_milestone: boolean;
};
type SubscriptionRow = { status: string; trial_ends_at: string | null; current_period_end: string | null };

function trialDaysLeft(trialEndsAt: string | null): number {
  if (!trialEndsAt) return 0;
  const ms = new Date(trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

// Status pill/row text + colour for the 4 subscription states this screen
// distinguishes (Trial · N days left / Active / Lapsed / Canceled), derived
// from `subscription.status` + `trial_ends_at`/`current_period_end`.
function statusPill(sub: SubscriptionRow | null): { label: string; colour: string } {
  if (!sub || sub.status === "lapsed") return { label: "Lapsed", colour: "var(--red)" };
  if (sub.status === "trial") {
    const days = trialDaysLeft(sub.trial_ends_at);
    return { label: `Trial · ${days} day${days === 1 ? "" : "s"} left`, colour: "var(--brand-green)" };
  }
  if (sub.status === "active") return { label: "Active", colour: "var(--brand-green)" };
  if (sub.status === "canceled") return { label: "Canceled", colour: "var(--muted)" };
  return { label: sub.status, colour: "var(--muted)" };
}

export default async function AccountPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  const userId = user!.id;

  const [{ data: subscriberRow }, { data: subscriptionRow }] = await Promise.all([
    sb.from("app_user")
      .select("name,email,phone,pref_new_post,pref_race_day,pref_race_result,pref_milestone")
      .eq("id", userId).maybeSingle(),
    sb.from("subscription").select("status,trial_ends_at,current_period_end").eq("user_id", userId).maybeSingle(),
  ]);

  const row = subscriberRow as (SubscriberRow & PrefsRow) | null;
  const sub = subscriptionRow as SubscriptionRow | null;

  const subscriber: AccountSubscriber = {
    name: row?.name ?? "",
    email: row?.email ?? user?.email ?? "",
    phone: row?.phone ?? "",
  };
  const prefs: AccountPrefs = row
    ? { newPost: row.pref_new_post, raceDay: row.pref_race_day, raceResult: row.pref_race_result, milestone: row.pref_milestone }
    : { newPost: true, raceDay: true, raceResult: true, milestone: true };

  const isTrial = sub?.status === "trial";
  const needsSubscribe = !sub || sub.status === "trial" || sub.status === "lapsed";
  const { label: pillLabel, colour: pillColour } = statusPill(sub);
  const days = trialDaysLeft(sub?.trial_ends_at ?? null);

  return (
    <div className="settings-page">
      <h1 className="settings-h">Account</h1>
      <p className="settings-sub">Manage your profile, subscription, and notifications.</p>

      <div className="settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Subscription</h3>
            <div className="sub">Your access and billing</div>
          </div>
          <a href="/checkout" className="btn btn-primary" style={{ padding: "9px 18px", fontSize: 13.5 }}>
            {needsSubscribe ? "Subscribe now" : "Manage"}
          </a>
        </div>
        <div className="settings-row">
          <span className="label">Status</span>
          <span className="value" style={{ color: pillColour }}>{pillLabel}</span>
        </div>
        <div className="plan-card-inner">
          <div className="plan-row">
            <div>
              <p className="plan-name">{isTrial ? "Trial - Full access" : "StablePass"}</p>
              <div className="plan-meta">
                {isTrial ? `${days} day${days === 1 ? "" : "s"} remaining · no card on file` : pillLabel}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="plan-price">AU$19/month</div>
              <div className="plan-meta">{isTrial ? "when trial ends" : "flat monthly plan"}</div>
            </div>
          </div>
          <p style={{ fontSize: 13.5, color: "var(--muted)", margin: 0, lineHeight: 1.55 }}>
            {isTrial
              ? "You're on a free trial. When your trial ends, you can choose to subscribe - nothing happens automatically and we won't charge you without your card on file."
              : "Manage your plan from here — cancellation keeps access until the end of the current billing period."}
          </p>
        </div>
      </div>

      <AccountForms initialSubscriber={subscriber} initialPrefs={prefs} />
    </div>
  );
}
