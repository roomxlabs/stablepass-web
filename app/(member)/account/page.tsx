// Account screen (09-account.html, MINUS Devices & sessions — single-device
// guardrail, .rx/guardrails.md #5: no devices/sessions UI, just Sign out).
// Server component under the (member) shell (auth already guarded by
// app/(member)/layout.tsx). Reads the same subscriber/subscription/prefs shape
// as GET /api/me directly via supabaseServer, avoiding an internal fetch — same
// pattern as the W7 horse-profile page. The Subscription card is static (its
// CTA just links to /checkout; W10 owns the real billing flow). The Profile +
// Notifications forms and Sign out are the interactive AccountForms island.
import { supabaseServer } from "@/lib/supabase/server";
import { ACCESS_COLUMNS, hasAccess } from "@/lib/api/access";
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

// Has this timestamp already passed?
//
// ⚠️ Needed because NOT-entitled does NOT imply the date has passed.
// `hasAccess()` denies `canceled`/`lapsed` on the STATUS alone, without reading
// the date, and those rows legitimately carry a FUTURE `current_period_end`
// (docs/specs/database.sql: "canceled keeps access until this"). Deriving a past
// tense from `!entitled` would print "Ended 26 August 2026" ten days BEFORE that
// date — a fresh instance of the exact bug this ticket is about, just inverted.
// So the copy asks the clock, not the gate.
//
// A module-scope helper rather than an inline `Date.now()` in the component: the
// repo's lint forbids calling an impure function during render, which is why
// `trialDaysLeft` and `formatEndDate` are shaped this way too. `now` is
// injectable for the same reason it is on `hasAccess`.
function hasPassed(iso: string | null, now: number = Date.now()): boolean {
  if (!iso) return false;
  const ts = Date.parse(iso);
  return !Number.isNaN(ts) && ts <= now;
}

// Status pill/row text + colour.
//
// ── ENG-585: THIS IS DERIVED FROM ENTITLEMENT, NOT FROM `status` ────────────
// It used to read the raw `status` string, and the `active` branch returned
// "Active" without ever looking at `current_period_end` — so a member whose
// pass expired an hour ago opened the one screen that explains their account
// and was told everything was fine, next to an "Extend access" button, under a
// line promising access to a date that had already passed. The server was
// denying them correctly the whole time; only this screen lied.
//
// So entitlement is asked FIRST, from the shared `hasAccess()` (lib/api/access.ts,
// ENG-569) — the same predicate the BFF, the expiry banner and the backend's
// `has_content_access()` use. The raw status is then only allowed to choose
// BETWEEN WORDINGS ("trial ended" vs "ended"), never to decide the answer.
//
// ⚠️ `current_period_end IS NULL` on an `active` row means ENTITLED, not
// expired — that is a member who has just paid and whose Stripe webhook has not
// landed yet. `hasAccess()` already encodes that, which is precisely why this
// function must not re-derive it. Three tickets (ENG-566/577/582) have had to
// get this same null right one layer down.
function statusPill(sub: SubscriptionRow | null, entitled: boolean): { label: string; colour: string } {
  if (entitled) {
    if (sub?.status === "trial") {
      const days = trialDaysLeft(sub.trial_ends_at);
      return { label: `Trial · ${days} day${days === 1 ? "" : "s"} left`, colour: "var(--brand-green)" };
    }
    return { label: "Active", colour: "var(--brand-green)" };
  }
  // Not entitled. "Lapsed" / "Canceled" were internal status vocabulary leaking
  // onto the member's screen; what they need to know is that it has ended, and
  // whether the thing that ended was the free trial or a pass they paid for.
  if (sub?.status === "trial") return { label: "Trial ended", colour: "var(--red)" };
  return { label: "Ended", colour: "var(--red)" };
}

export default async function AccountPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  const userId = user!.id;

  const [{ data: subscriberRow }, { data: subscriptionRow }] = await Promise.all([
    sb.from("app_user")
      .select("first_name,last_name,email,phone,pref_new_post,pref_race_day,pref_race_result,pref_milestone")
      .eq("id", userId).maybeSingle(),
    // ACCESS_COLUMNS, not a hand-written list: this row is fed to `hasAccess()`
    // below, and a select that drifts from what that helper reads is invisible
    // to `tsc` (`sb` is untyped) — it just fails CLOSED at runtime. Same
    // structural fix the (member) layout already uses.
    sb.from("subscription").select(ACCESS_COLUMNS).eq("user_id", userId).maybeSingle(),
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

  // ENG-585: every line below hangs off `entitled`, not off the status string.
  // The old code asked `status === "active"` and then printed "Access to <past
  // date>" and "Your access runs to <past date>" from a `current_period_end`
  // nobody had compared to the clock.
  const entitled = hasAccess(sub);
  const isTrial = sub?.status === "trial";
  const { label: pillLabel, colour: pillColour } = statusPill(sub, entitled);
  const days = trialDaysLeft(sub?.trial_ends_at ?? null);
  const endDate = formatEndDate(sub?.current_period_end ?? null);

  // A member who is entitled on a trial, an entitled paid member, and a member
  // whose access is gone are three different screens — and only the first two
  // are "you have access".
  const onTrial = entitled && isTrial;
  const onPass = entitled && !isTrial;

  const endedInPast = hasPassed(sub?.current_period_end ?? null);

  // The pass does NOT auto-renew and there is no cancel route to reach
  // (ENG-567 deleted /api/subscription/cancel outright), so the whole card is
  // written as "buy days", never as "manage a plan". An active member is an
  // early renewal, not a subscriber with something to cancel — which is why
  // even they get a forward CTA rather than a "Manage" one.
  //
  // "Extend access" is only honest while there is access to extend. Once it has
  // ended the CTA is the wall's CTA — the same "Buy 30 days" the member sees on
  // every other screen and on mobile.
  const ctaLabel = onPass ? "Extend access" : "Buy 30 days";

  const planName = onTrial ? "Trial — full access" : onPass ? "30-day pass" : "No active pass";
  const planMeta = onTrial
    ? `${days} day${days === 1 ? "" : "s"} remaining · no card on file`
    : onPass
      ? endDate
        ? `Access to ${endDate}`
        : // `current_period_end` is null and the member IS entitled: they have
          // just paid and the webhook has not landed. Not expired — do not
          // print a date we do not have yet.
          "Access active"
      : endedInPast
        ? // Past tense, and only ever for a date that IS in the past — see
          // `endedInPast`. This is the one honest use of the date: "Ended 16
          // August 2026" tells the member what happened, where "Access to 16
          // August 2026" told them it was still running.
          `Ended ${endDate}`
        : "Access ended";

  // No price anywhere on this card. The amount is whatever the Stripe price
  // says at checkout (A$1.00 in sandbox, A$19.00 in production) — a literal
  // here would make the screen claim one number while Stripe charges another,
  // and "AU$19/month" additionally implied a monthly plan that does not exist.
  const planCopy = onTrial
    ? "You're on a free trial. When it ends you can choose to buy 30 days — nothing happens automatically and we have no card on file."
    : onPass
      ? endDate
        ? `Your access runs to ${endDate}. It does not renew — buy another 30 days whenever you like, and any days you've already paid for are kept.`
        : "Your access is active. It does not renew — buy another 30 days whenever you like, and any days you've already paid for are kept."
      : isTrial
        ? "Your free trial has ended. Buy 30 days to pick up where you left off."
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
