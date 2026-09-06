// The single place the entitlement rule is written in this repo.
//
// This is the THIRD copy of the access gate. The other two live in
// stablepass-be and are owned by ENG-1025:
//
//   1. SQL `has_content_access(uid)`
//        supabase/migrations/20260906120000_auto_renew_subscription.sql
//   2. Edge `hasContentAccess()`
//        supabase/functions/_shared/access.ts
//   3. This file — the BFF / client helper
//
// THE THREE COPIES MUST MOVE TOGETHER. Nothing derives this file from the
// database. If this helper stays strict while the backend grants a 3-day
// renewal grace, a member in the renewal window gets content from RLS and a
// 402 envelope from the BFF — the split-brain ENG-577 existed to remove.
//
// ENG-1025 splits the statuses that ENG-999 had sharing one expiry branch:
//
//   (status = 'active'
//      and (current_period_end is null
//           or current_period_end + interval '3 days' > now()))
//   or (status = 'canceled' and current_period_end > now())
//
// `active` gets the 3-day grace because under auto-renew an elapsed
// `current_period_end` is a date we expect to move (renewal webhook late),
// not a real ending. `canceled` stays strict — a cancelled period end is a
// real ending, and three free days past it is a bug the member notices on
// their last day. A NULL period grants on `active` only (webhook in flight);
// on `canceled` it does not (SQL `current_period_end > now()` is not true
// for NULL).
//
// The `trial` branch is still GONE — ENG-999 retired the free trial. A
// `trial` row (legacy only) is not entitled here, which is the same answer
// the backend gives it.
//
// RLS is the security boundary and this helper is the clean-402-envelope
// layer: without it an expired member gets an empty list instead of a
// reactivate prompt. Never remove the DB-side check because this one exists.
//
// `trial_ends_at` stays in the column list and on the row type on purpose.
// `app/(member)/layout.tsx` still reads it for the sidebar chip and is
// outside this slice's surface; dropping the column here would leave that
// select narrower than its reader — invisible to `tsc` (`sb` is untyped)
// and a runtime-only failure. The rule below simply no longer consults it.
export const ACCESS_COLUMNS = "status,trial_ends_at,current_period_end";

export type AccessRow = {
  status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
};

// 3-day renewal grace for `active` only. Matches SQL
// `current_period_end + interval '3 days' > now()` and the ENG-1025
// `_shared/access.ts` copy. `canceled` does not use this.
const RENEWAL_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

// `now` is injectable so tests are deterministic — call sites pass nothing.
// An unparseable timestamp yields NaN, every comparison is false, so it fails CLOSED.
export function hasAccess(sub: AccessRow | null, now: number = Date.now()): boolean {
  if (!sub) return false;
  if (sub.status === "active") {
    return sub.current_period_end === null
      || Date.parse(sub.current_period_end) + RENEWAL_GRACE_MS > now;
  }
  if (sub.status === "canceled") {
    return sub.current_period_end !== null && Date.parse(sub.current_period_end) > now;
  }
  return false;
}

// ── ENG-585: the second question the SCREENS ask ────────────────────────────
// `hasAccess()` answers "can this member see content right now". The walls need
// one more bit to say the right sentence: has this member EVER paid us?
//
// The rule is `stripe_customer_id !== null` and it is written HERE, once, for
// the same reason `hasAccess` is: mobile (ENG-573) branches its wall copy on
// exactly this, and a second web-side copy is how the two platforms start
// telling the same member different things. Whoever widens this rule widens
// every wall at once.
//
// `stripe_customer_id` is a Stripe identifier, not member data, and it never
// leaves the server: every call site turns it into a BOOLEAN before it crosses
// into a client component. Pass `everSubscribed`, never the row.
export type SubscriptionRow = AccessRow & { stripe_customer_id: string | null };

// The column list for any select that feeds BOTH helpers below. Same structural
// trick as ACCESS_COLUMNS: `sb` is untyped, so a hand-written select that forgot
// `stripe_customer_id` type-checks clean and silently tells a paying member their
// trial ended. Use the constant.
export const SUBSCRIPTION_COLUMNS = `${ACCESS_COLUMNS},stripe_customer_id`;

export function everSubscribed(sub: { stripe_customer_id: string | null } | null): boolean {
  return (sub?.stripe_customer_id ?? null) !== null;
}
