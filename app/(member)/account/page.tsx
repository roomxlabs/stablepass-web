// Account screen (09-account.html, MINUS Devices & sessions — single-device
// guardrail, .rx/guardrails.md #5: no devices/sessions UI, just Sign out).
// Server component under the (member) shell (auth already guarded by
// app/(member)/layout.tsx). Reads the same subscriber/subscription/prefs shape
// as GET /api/me directly via supabaseServer, avoiding an internal fetch — same
// pattern as the W7 horse-profile page. The Profile + Notifications forms and
// Sign out are the interactive AccountForms island; the Cancel control at the
// foot of the Subscription card is the CancelCard island (ENG-1002).
//
// ENG-1028 rewrites the Subscription card for an auto-renewing membership:
// next charge, intro → standard change-over, manage-card (Billing Portal),
// cancel. The mockup has none of those three controls — compose from
// `.settings-card` / `.settings-card-head` / `.settings-row` / `.plan-row` /
// `.btn` already on this screen. No new colours, no new component family.
//
// ENG-999 retired the free trial, so there is no trial wording anywhere on this
// screen any more — not as a pill, not as a plan name, not as a day count.
import { getStripe } from "@/lib/stripe";
import { supabaseServer } from "@/lib/supabase/server";
import { hasAccess, type AccessRow } from "@/lib/api/access";
import { AccountForms, type AccountPrefs, type AccountSubscriber } from "./account-forms";
import { CancelCard } from "./cancel-card";
import {
  ACCOUNT_SUB_COLUMNS,
  addCalendarMonthsSydney,
  formatMoney,
  isFailedRenewal,
  nextChargeAmount,
  remainingIntroMonths,
  type AccountSubRow,
  type StripePricing,
} from "./billing";

export const metadata = { title: "Account · StablePass" };

const HEAD_BTN = { padding: "9px 18px", fontSize: 13.5 } as const;

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

// "14 September 2026". Used only in prose about when access ends / the next
// charge lands — never for a countdown, which stays on the shared Math.ceil
// day convention above.
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
//
// (ENG-1002 narrowed WHY. This used to say "hasAccess() denies canceled/lapsed
// on the STATUS alone"; `canceled` is now an entitled status that DOES read the
// date, so `lapsed` is the remaining case — and a `lapsed` row can legitimately
// carry a FUTURE `current_period_end`, e.g. a member lapsed by hand or by a
// webhook before their period ran out.) Deriving a past tense from `!entitled`
// would print "Ended 26 August 2026" ten days BEFORE that date — a fresh
// instance of the exact bug this file is about, just inverted. So the copy asks
// the clock, not the gate.
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
// and was told everything was fine, next to a buy-days button, under a
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

async function readStripePricing(remaining: number): Promise<StripePricing | null> {
  const stripe = getStripe();
  const priceId = process.env.STRIPE_PRICE_ID_STANDARD;
  if (!stripe || !priceId) return null;
  try {
    const price = await stripe.prices.retrieve(priceId);
    if (price.unit_amount == null) return null;
    let discountAmount = 0;
    if (remaining > 0) {
      const coupon = await stripe.coupons.retrieve(`intro_${remaining}`);
      if (typeof coupon.amount_off !== "number") return null;
      discountAmount = coupon.amount_off;
    }
    return {
      unitAmount: price.unit_amount,
      discountAmount,
      currency: price.currency ?? "aud",
    };
  } catch (err) {
    console.error(
      "[account] Stripe price/coupon retrieve failed — omitting amounts rather than guessing: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export default async function AccountPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  const userId = user!.id;

  const [{ data: subscriberRow }, { data: subscriptionRow }] = await Promise.all([
    sb.from("app_user")
      .select("first_name,last_name,email,phone,pref_new_post,pref_race_day,pref_race_result,pref_milestone")
      .eq("id", userId).maybeSingle(),
    // ACCOUNT_SUB_COLUMNS, not a hand-written list: this row is fed to
    // `hasAccess()` plus the intro / portal / payment-failed branches, and a
    // select that drifts from what those helpers read is invisible to `tsc`
    // (`sb` is untyped) — it just fails CLOSED at runtime.
    sb.from("subscription").select(ACCOUNT_SUB_COLUMNS).eq("user_id", userId).maybeSingle(),
  ]);

  const row = subscriberRow as (SubscriberRow & PrefsRow) | null;
  const sub = subscriptionRow as AccountSubRow | null;

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
  const entitled = hasAccess(sub);
  const { label: pillLabel, colour: pillColour } = statusPill(sub, entitled);
  const endDate = formatEndDate(sub?.current_period_end ?? null);

  const canceled = sub?.status === "canceled";
  const endedInPast = hasPassed(sub?.current_period_end ?? null);
  const paymentFailed = !entitled && isFailedRenewal(sub);
  const remaining = remainingIntroMonths(sub?.intro_months_used);
  const hasCustomer = (sub?.stripe_customer_id ?? null) !== null;

  // Who is offered the Cancel control (ENG-1002). All three clauses are
  // load-bearing:
  //   * `entitled` — a lapsed member has nothing to cancel, and the RPC would
  //     answer 409 anyway. Offering it would be a button that only ever fails.
  //   * `status === "active"` — an already-cancelled member must not be shown
  //     it. This is the ONE place the raw status is read for a decision rather
  //     than for wording, legitimately: the question is "is there an active row
  //     for the RPC to cancel", which IS the status.
  //   * `current_period_end !== null` — a null period means the member has
  //     JUST PAID and the Stripe webhook is still in flight.
  //     `cancel_own_subscription()` stamps `current_period_end =
  //     coalesce(current_period_end, now())`. Cancelling in that window
  //     revokes access IMMEDIATELY. The window is seconds long; the control
  //     waits for the period to land.
  const canCancel = entitled && sub?.status === "active" && sub.current_period_end !== null;

  // Amounts come from Stripe (standard price + intro coupon) or we omit them.
  // Never a literal that can disagree with what Stripe will charge.
  const pricing = entitled && !canceled ? await readStripePricing(remaining) : null;
  const standardLabel = pricing ? formatMoney(pricing.unitAmount, pricing.currency) : null;
  const nextLabel = pricing ? formatMoney(nextChargeAmount(pricing, remaining), pricing.currency) : null;
  const changeOverDate = sub?.current_period_end
    ? addCalendarMonthsSydney(sub.current_period_end, remaining)
    : null;

  const showNextCharge = entitled && !canceled && !!endDate;
  const showChangeOver = entitled && !canceled && remaining > 0;

  const planName = entitled
    ? "Monthly membership"
    : paymentFailed
      ? "Payment failed"
      : "No active subscription";
  const planMeta = entitled
    ? canceled
      ? endDate
        ? `Access until ${endDate}`
        : "Access until the end of this period"
      : endDate
        ? `Access until ${endDate}`
        : "Access active"
    : paymentFailed
      ? "Update your card to continue"
      : endedInPast && endDate
        ? `Ended ${endDate}`
        : "Access ended";

  let planCopy: string;
  if (entitled && canceled) {
    planCopy = endDate
      ? `You've cancelled. Your access continues until ${endDate}. You won't be charged again.`
      : "You've cancelled. Your access continues to the end of this period. You won't be charged again.";
  } else if (entitled) {
    planCopy = endDate
      ? `Your membership renews on ${endDate}. Cancel any time — you'll keep access until then.`
      : "Your membership is active. Cancel any time — you'll keep access to the end of the period you've paid for.";
  } else if (paymentFailed) {
    planCopy = "Your payment didn't go through. Update your card to keep your membership.";
  } else {
    planCopy = "Your access has ended. Subscribe to pick up where you left off.";
  }

  const headCta = paymentFailed || !entitled
    ? { href: "/checkout", label: "Subscribe" }
    : hasCustomer
      ? { href: "/api/subscription/portal", label: "Manage card" }
      : null;

  return (
    <div className="settings-page">
      <h1 className="settings-h">Account</h1>
      <p className="settings-sub">Manage your profile, subscription, and notifications.</p>

      <div className="settings-card" data-testid="subscription-card">
        <div className="settings-card-head">
          <div>
            <h3>Subscription</h3>
            <div className="sub">Your access and billing</div>
          </div>
          {headCta && (
            <a href={headCta.href} className="btn btn-primary" style={HEAD_BTN}>
              {headCta.label}
            </a>
          )}
        </div>
        <div className="settings-row">
          <span className="label">Status</span>
          <span className="value" style={{ color: pillColour }}>{pillLabel}</span>
        </div>
        {showNextCharge && (
          <div className="settings-row" data-testid="next-charge">
            <span className="label">Next charge</span>
            <span className="value">
              {nextLabel ? `${nextLabel} on ${endDate}` : `On ${endDate}`}
            </span>
          </div>
        )}
        {showChangeOver && (
          <div className="settings-row" data-testid="change-over">
            <span className="label">Then</span>
            <span className="value">
              {standardLabel && changeOverDate
                ? `${standardLabel} from ${changeOverDate}`
                : standardLabel
                  ? `${standardLabel} per month`
                  : "the standard monthly price"}
            </span>
          </div>
        )}
        <div className="plan-card-inner">
          <div className="plan-row">
            <div>
              <p className="plan-name">{planName}</p>
              <div className="plan-meta">{planMeta}</div>
            </div>
          </div>
          <p
            style={{ fontSize: 13.5, color: "var(--muted)", margin: 0, lineHeight: 1.55 }}
            data-testid={paymentFailed ? "payment-failed" : undefined}
          >
            {planCopy}
            {paymentFailed && (
              <>
                {" "}
                <a href="/api/subscription/portal" style={{ color: "var(--brand-green)", fontWeight: 500 }}>
                  Update your card
                </a>
              </>
            )}
          </p>
        </div>
        {/*
          ENG-1002. Rendered INSIDE the Subscription card, at its foot, because
          the sentence it needs the member to have read — "access continues
          until <date>" — is the one directly above it. It is a client island
          only for the confirm step's local state; the card around it stays a
          server component, and the island is handed a FORMATTED STRING, never
          the row. Absent entirely for a cancelled or lapsed member.
        */}
        {canCancel && <CancelCard endDate={endDate} />}
      </div>

      <AccountForms initialSubscriber={subscriber} initialPrefs={prefs} />
    </div>
  );
}
