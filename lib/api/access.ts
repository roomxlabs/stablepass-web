// The single place the entitlement rule is written in this repo.
//
// Mirrors stablepass-be `has_content_access(uid)` — keep the two in lockstep.
// As rewritten by ENG-999 (paid-only subscription, `feature/pricing-v1`) both
// sides now read:
//
//   status in ('active','canceled')
//   and (current_period_end is null or current_period_end > now())
//
// `canceled` GRANTS access. That is not a bug and it is not generosity: the
// 30-day pass is bought outright and non-renewing, so cancelling is a
// statement about the NEXT pass, not a refund of the one already paid for.
// A cancelled member keeps everything they bought until `current_period_end`
// and lapses at it, exactly like an uncancelled one. ENG-1002's whole point is
// that this screen, this helper and the DB agree about that.
//
// The `trial` branch is GONE — ENG-999 retired the free trial, and the DB
// function no longer has a trial arm either. A `trial` row (there are only
// legacy ones) is therefore not entitled here, which is the same answer the
// backend gives it.
//
// RLS is the security boundary and this helper is the clean-402-envelope layer:
// without it an expired member gets an empty list instead of a reactivate
// prompt. Never remove the DB-side check because this one exists.
//
// (The old warning here said the DEPLOYED `has_content_access()` was still
// status-only and this helper was the only thing honouring expiry. That
// stopped being true when stablepass-be ENG-566 shipped the expiry-aware
// version, and ENG-999 has since rewritten it again — defence in depth is
// real now, so the two really must not drift.)
//
// `trial_ends_at` stays in the column list and on the row type on purpose.
// `app/(member)/layout.tsx` still reads it for the sidebar chip and is outside
// this slice's surface; dropping the column here would leave that select
// narrower than its reader — invisible to `tsc` (`sb` is untyped) and a
// runtime-only failure. The rule below simply no longer consults it.
export const ACCESS_COLUMNS = "status,trial_ends_at,current_period_end";

export type AccessRow = {
  status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
};

// `now` is injectable so tests are deterministic — call sites pass nothing.
// An unparseable timestamp yields NaN, every comparison is false, so it fails CLOSED.
export function hasAccess(sub: AccessRow | null, now: number = Date.now()): boolean {
  if (!sub) return false;
  // `canceled` sits alongside `active` deliberately — see the header. Both are
  // "you have paid for a period"; only the date decides whether it is over.
  if (sub.status === "active" || sub.status === "canceled") {
    return sub.current_period_end === null || Date.parse(sub.current_period_end) > now;
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
