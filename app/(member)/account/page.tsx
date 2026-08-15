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

type SubscriberRow = {
  // `first_name`/`last_name` are the source of truth as of ENG-566; `name`
  // survives as a plain column kept in sync by the `app_user_name_sync` BEFORE
  // trigger (NOT a GENERATED column — it has to stay writable for the released
  // mobile build), which is why the form below edits the structured pair and
  // this screen never has to split a name client-side.
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
};
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

// "14 September 2026". Used only in prose about when access ends — never for a
// countdown, which stays on the shared Math.ceil day convention above.
//
// The timezone is PINNED, not left to the host. This renders on the server, so
// without it the date is formatted in whatever zone the container runs in: a
// `current_period_end` of 2026-08-22T14:00:00Z reads as "22 August" on a UTC
// host and as 23 August to the Sydney member it is a promise to. StablePass is
// an AU-only product, so the member's day is the correct one to print.
function formatEndDate(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return new Date(ts).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Australia/Sydney",
  });
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
      .select("first_name,last_name,email,phone,pref_new_post,pref_race_day,pref_race_result,pref_milestone")
      .eq("id", userId).maybeSingle(),
    sb.from("subscription").select("status,trial_ends_at,current_period_end").eq("user_id", userId).maybeSingle(),
  ]);

  const row = subscriberRow as (SubscriberRow & PrefsRow) | null;
  const sub = subscriptionRow as SubscriptionRow | null;

  // ENG-566's backfill has already populated first/last for every legacy
  // `name`-only member, so these render populated. If both really are empty the
  // inputs render empty — deliberately no client-side splitting of `name`.
  const subscriber: AccountSubscriber = {
    firstName: row?.first_name ?? "",
    lastName: row?.last_name ?? "",
    email: row?.email ?? user?.email ?? "",
    phone: row?.phone ?? "",
  };
  const prefs: AccountPrefs = row
    ? { newPost: row.pref_new_post, raceDay: row.pref_race_day, raceResult: row.pref_race_result, milestone: row.pref_milestone }
    : { newPost: true, raceDay: true, raceResult: true, milestone: true };

  const isTrial = sub?.status === "trial";
  const isActive = sub?.status === "active";
  const { label: pillLabel, colour: pillColour } = statusPill(sub);
  const days = trialDaysLeft(sub?.trial_ends_at ?? null);
  const endDate = formatEndDate(sub?.current_period_end ?? null);

  // The pass does NOT auto-renew and there is no cancel route to reach
  // (ENG-567 deleted /api/subscription/cancel outright), so the whole card is
  // written as "buy days", never as "manage a plan". An active member is an
  // early renewal, not a subscriber with something to cancel — which is why
  // even they get a forward CTA rather than a "Manage" one.
  const ctaLabel = isActive ? "Extend access" : "Buy 30 days";

  const planName = isTrial ? "Trial — full access" : isActive ? "30-day pass" : "No active pass";
  const planMeta = isTrial
    ? `${days} day${days === 1 ? "" : "s"} remaining · no card on file`
    : isActive
      ? endDate
        ? `Access to ${endDate}`
        : "Access active"
      : "Access ended";

  // No price anywhere on this card. The amount is whatever the Stripe price
  // says at checkout (A$1.00 in sandbox, A$19.00 in production) — a literal
  // here would make the screen claim one number while Stripe charges another,
  // and "AU$19/month" additionally implied a monthly plan that does not exist.
  const planCopy = isTrial
    ? "You're on a free trial. When it ends you can choose to buy 30 days — nothing happens automatically and we have no card on file."
    : isActive
      ? endDate
        ? `Your access runs to ${endDate}. It does not renew — buy another 30 days whenever you like, and any days you've already paid for are kept.`
        : "Your access is active. It does not renew — buy another 30 days whenever you like, and any days you've already paid for are kept."
      : "Your access has ended. Buy 30 days to pick up where you left off.";

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
            {ctaLabel}
          </a>
        </div>
        <div className="settings-row">
          <span className="label">Status</span>
          <span className="value" style={{ color: pillColour }}>{pillLabel}</span>
        </div>
        <div className="plan-card-inner">
          <div className="plan-row">
            <div>
              <p className="plan-name">{planName}</p>
              <div className="plan-meta">{planMeta}</div>
            </div>
          </div>
          <p style={{ fontSize: 13.5, color: "var(--muted)", margin: 0, lineHeight: 1.55 }}>{planCopy}</p>
        </div>
      </div>

      <AccountForms initialSubscriber={subscriber} initialPrefs={prefs} />
    </div>
  );
}
