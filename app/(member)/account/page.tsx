// Account screen (09-account.html, MINUS Devices & sessions — single-device
// guardrail, .rx/guardrails.md #5: no devices/sessions UI, just Sign out).
// Server component under the (member) shell (auth already guarded by
// app/(member)/layout.tsx). Reads the same subscriber/subscription/prefs shape
// as GET /api/me directly via supabaseServer, avoiding an internal fetch — same
// pattern as the W7 horse-profile page. The Profile + Notifications forms and
// Sign out are the interactive AccountForms island; the Cancel control at the
// foot of the Subscription card is the CancelCard island (ENG-1002).
//
// ENG-999 retired the free trial, so there is no trial wording anywhere on this
// screen any more — not as a pill, not as a plan name, not as a day count. The
// branches were removed rather than left unreachable.
import { supabaseServer } from "@/lib/supabase/server";
import { ACCESS_COLUMNS, hasAccess, type AccessRow } from "@/lib/api/access";
import { AccountForms, type AccountPrefs, type AccountSubscriber } from "./account-forms";
import { CancelCard } from "./cancel-card";

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
// The subscription row is typed as `AccessRow` — the type that travels WITH
// `ACCESS_COLUMNS` — rather than a local restatement of the same three columns.
// A local copy is how a select and its reader drift, and `sb` is untyped so
// nothing would catch it. `trial_ends_at` is still in both because
// `app/(member)/layout.tsx` still reads it; this screen does not.

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
// `formatEndDate` is shaped this way too. `now` is injectable for the same
// reason it is on `hasAccess`.
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
// BETWEEN WORDINGS, never to decide the answer.
//
// ⚠️ `current_period_end IS NULL` on an `active` row means ENTITLED, not
// expired — that is a member who has just paid and whose Stripe webhook has not
// landed yet. `hasAccess()` already encodes that, which is precisely why this
// function must not re-derive it. Three tickets (ENG-566/577/582) have had to
// get this same null right one layer down.
// ⚠️ ENG-1002 extends this WITHOUT disturbing that ordering. `canceled` is now
// an ENTITLED status (the member paid for a period and cancelling does not
// refund it), so it is answered inside the `entitled` branch and the raw status
// only picks between "Active" and "Access ending" — exactly the licence the
// paragraph above grants it. Putting a `status === "canceled"` test ahead of
// the entitlement question would re-introduce the ENG-585 bug with the sign
// flipped: a member who cancelled this morning, still has 29 paid days, and
// would be told their access had ended.
//
// Both entitled wordings stay GREEN. The colour answers "do you have access",
// which is the entitlement question and is `true` for both; the WORDING carries
// "and it is winding down". A third state colour would be a new treatment this
// screen's design has no reference for.
function statusPill(sub: AccessRow | null, entitled: boolean): { label: string; colour: string } {
  if (entitled) {
    if (sub?.status === "canceled") {
      return { label: "Access ending", colour: "var(--brand-green)" };
    }
    return { label: "Active", colour: "var(--brand-green)" };
  }
  // Not entitled. "Lapsed" / "Canceled" were internal status vocabulary leaking
  // onto the member's screen; what they need to know is that it has ended.
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
  const sub = subscriptionRow as AccessRow | null;

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
  const { label: pillLabel, colour: pillColour } = statusPill(sub, entitled);
  const endDate = formatEndDate(sub?.current_period_end ?? null);

  // Two screens now, not three: you have access, or you do not. Within "you
  // have access" the only remaining question is whether it is winding down.
  const canceled = sub?.status === "canceled";
  const endedInPast = hasPassed(sub?.current_period_end ?? null);

  // Who is offered the Cancel control (ENG-1002). Both halves are load-bearing:
  //   * `entitled` — a lapsed member has nothing to cancel, and the RPC would
  //     answer 409 anyway. Offering it would be a button that only ever fails.
  //   * `status === "active"` — an already-cancelled member must not be shown
  //     it, and this is the ONE place the raw status is read for a decision
  //     rather than for wording. That is legitimate here and not an ENG-585
  //     regression: the question is "is there an active row for the RPC to
  //     cancel", which IS the status, not "does this member have access".
  const canCancel = entitled && sub?.status === "active";

  // The pass does NOT auto-renew, so the card is still written as "buy days",
  // never as "manage a plan" — even for a cancelled member, whose next purchase
  // is a fresh pass rather than a resumed plan. Cancelling (ENG-1002) stops the
  // NEXT pass, it does not end this one, so it does not change the CTA either:
  // buying more days stays open to a cancelled member for as long as anyone.
  //
  // "Extend access" is only honest while there is access to extend. Once it has
  // ended the CTA is the wall's CTA — the same "Buy 30 days" the member sees on
  // every other screen and on mobile.
  const ctaLabel = entitled ? "Extend access" : "Buy 30 days";

  const planName = entitled ? "30-day pass" : "No active pass";
  const planMeta = entitled
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
  //
  // The cancelled-but-entitled sentence is the new one (ENG-1002) and it has to
  // say BOTH halves: access continues to <date>, and it will not continue after
  // that. Saying only the first reads like nothing happened; saying only the
  // second reads like they have been cut off today.
  const planCopy = entitled
    ? canceled
      ? endDate
        ? `You've cancelled. Your access continues to ${endDate} and will not continue after that. The days you've already paid for are yours to keep — you can buy another 30 days whenever you like.`
        : "You've cancelled. Your access continues to the end of the period you've paid for and will not continue after that. You can buy another 30 days whenever you like."
      : endDate
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
        {/*
          ENG-1002. Rendered INSIDE the Subscription card, at its foot, because
          the sentence it needs the member to have read — "access continues to
          <date>" — is the one directly above it. It is a client island only for
          the confirm step's local state; the card around it stays a server
          component, and the island is handed a FORMATTED STRING, never the row.
          Absent entirely for a cancelled or lapsed member, so there is no
          disabled control and nothing to explain away.
        */}
        {canCancel && <CancelCard endDate={endDate} />}
      </div>

      <AccountForms initialSubscriber={subscriber} initialPrefs={prefs} />
    </div>
  );
}
