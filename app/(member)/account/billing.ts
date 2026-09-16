// Pure billing-display helpers for the Account Subscription card (ENG-1028).
//
// Amounts shown on the card MUST come from values the page read (Stripe price
// + coupon, or nothing). This file formats and derives dates; it does not
// invent A$9 / A$19 literals.

export const INTRO_MONTHS = 6;

export const ACCOUNT_SUB_COLUMNS =
  "status,trial_ends_at,current_period_end,intro_months_used,stripe_customer_id,canceled_at,provider";

export type AccountSubRow = {
  status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  intro_months_used: number | null;
  stripe_customer_id: string | null;
  canceled_at: string | null;
  // ENG-1192 / ENG-1185: who bills this row — `stripe` | `app_store` |
  // `play_store` | `promotional`. A PRESENTATION switch only: entitlement is
  // still `hasAccess()` on status + period, never this column. `null` (a row
  // read before the migration) is treated as `stripe`.
  provider: string | null;
};

export type StripePricing = {
  unitAmount: number;
  discountAmount: number;
  currency: string;
};

/**
 * Months of intro discount still to bill, including the upcoming charge.
 * A null/non-finite counter fails TOWARD the discount — same invariant as
 * checkout (R3): a bad read charges less, not more.
 */
export function remainingIntroMonths(used: unknown): number {
  const n = typeof used === "number" && Number.isFinite(used) ? used : 0;
  return Math.max(0, INTRO_MONTHS - n);
}

export function nextChargeAmount(pricing: StripePricing, remaining: number): number {
  const discount = remaining > 0 ? pricing.discountAmount : 0;
  return Math.max(0, pricing.unitAmount - discount);
}

/** Same formatter checkout uses — `en-US` so AUD renders as `A$19.00`. */
export function formatMoney(unitAmount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(unitAmount / 100);
}

/**
 * Add calendar months to a timestamp's Australia/Sydney civil date.
 * Returns a formatted `en-AU` date, or null when the input is unusable —
 * the page must then print the change-over WITHOUT a date rather than a
 * wrong one.
 */
export function addCalendarMonthsSydney(iso: string, months: number): string | null {
  if (!Number.isInteger(months) || months < 0) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ts));
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  if (!y || !m || !d) return null;

  const idx = m - 1 + months;
  const ny = y + Math.floor(idx / 12);
  const nm = ((idx % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  // UTC noon of the civil date so the printed day cannot slip a zone.
  return new Date(Date.UTC(ny, nm, nd, 12)).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Failed renewal: webhook set `lapsed` on `invoice.payment_failed`.
 * A never-subscribed signup row is also `lapsed` but has no customer.
 * A member who cancelled and then reached the period end keeps `canceled_at`.
 */
export function isFailedRenewal(sub: AccountSubRow | null): boolean {
  if (!sub) return false;
  // A store row carrying a leftover Stripe customer (a former web member who
  // later bought in the app) is NOT a failed card — the store bills it, and
  // "update your card" would send them to a portal for a subscription that no
  // longer exists. Only a Stripe (or pre-migration null) row can fail a renewal
  // we can help with.
  const stripeBilled = (sub.provider ?? null) === null || sub.provider === "stripe";
  return (
    stripeBilled &&
    sub.status === "lapsed" &&
    sub.stripe_customer_id !== null &&
    sub.canceled_at === null
  );
}

type ProviderRow = { provider?: string | null } | null | undefined;

/**
 * Billed by Apple or Google (ENG-1192). Such a row has no Stripe subscription
 * to cancel and no Billing Portal to open: the member manages it in the store.
 * The cancel + portal routes answer `409 managed_by_store` on this predicate.
 */
export function isStoreManaged(sub: ProviderRow): boolean {
  return sub?.provider === "app_store" || sub?.provider === "play_store";
}

/** Comp access granted from admin via a RevenueCat promotional entitlement. */
export function isComplimentary(sub: ProviderRow): boolean {
  return sub?.provider === "promotional";
}

export function providerLabel(provider: string | null | undefined): string {
  switch (provider) {
    case "app_store":
      return "App Store";
    case "play_store":
      return "Google Play";
    case "promotional":
      return "Complimentary";
    default:
      return "Web";
  }
}

/** Where a store-billed member changes their card or cancels. */
export function storeManageCopy(provider: string | null | undefined): string {
  return provider === "play_store"
    ? "To change your payment method or cancel, open Subscriptions in the Google Play app."
    : "To change your payment method or cancel, open Subscriptions in your iPhone Settings.";
}
