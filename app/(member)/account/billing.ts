// Pure billing-display helpers for the Account Subscription card (ENG-1028,
// Pricing v2 ENG-1328).
//
// Amounts shown on the card MUST come from values the page read (the Stripe
// price, or nothing). This file formats and classifies; it does not invent a
// price literal. The intro discount is retired — no coupon, no remaining-months
// arithmetic, no computed change-over date.

// `period_type` (be ENG-1323) is how a trial shows up: status stays `active`
// during a trial, and trial-vs-paid rides on this column. `trial_ends_at` is
// the retired ENG-999 column and is NOT how Pricing v2 reports a trial.
export const ACCOUNT_SUB_COLUMNS =
  "status,trial_ends_at,current_period_end,period_type,stripe_customer_id,canceled_at,provider";

export type AccountSubRow = {
  status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  // `trial` | `normal` | null (a row that predates Pricing v2, or has not yet
  // been through RevenueCat). Null reads as paid — never as a trial.
  period_type: string | null;
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
  currency: string;
};

/**
 * In a free trial right now. A PRESENTATION switch only — entitlement is still
 * `hasAccess()`; this picks "free until <date>" wording over "next charge".
 */
export function isTrialling(sub: { period_type?: string | null } | null | undefined): boolean {
  return sub?.period_type === "trial";
}

/** Same formatter checkout uses — `en-US` so AUD renders as `A$…` (en-AU would print a bare `$`). */
export function formatMoney(unitAmount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(unitAmount / 100);
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

/** The `409 managed_by_store` message — one copy, used by the cancel AND portal routes. */
export const MANAGED_BY_STORE_MESSAGE =
  "This subscription is managed through the App Store or Google Play.";

/** The cancel route's `409 complimentary` message (ENG-1276) — a promotional row has nothing to cancel. */
export const COMPLIMENTARY_MESSAGE =
  "Your complimentary access ends on its own, so there's nothing to cancel.";

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
