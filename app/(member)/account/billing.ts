// Pure billing-display helpers for the Account Subscription card (ENG-1028).
//
// Amounts shown on the card MUST come from values the page read (Stripe price
// + coupon, or nothing). This file formats and derives dates; it does not
// invent A$9 / A$19 literals.

export const INTRO_MONTHS = 6;

export const ACCOUNT_SUB_COLUMNS =
  "status,trial_ends_at,current_period_end,intro_months_used,stripe_customer_id,canceled_at";

export type AccountSubRow = {
  status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  intro_months_used: number | null;
  stripe_customer_id: string | null;
  canceled_at: string | null;
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
  return sub.status === "lapsed" && sub.stripe_customer_id !== null && sub.canceled_at === null;
}
