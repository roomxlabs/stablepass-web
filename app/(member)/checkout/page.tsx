// Checkout screen (04-checkout.html) — embedded Stripe Elements, no hosted
// redirect (.rx/guardrails.md #4).
//
// There is no free trial any more (ENG-999 retired it; `subscription.trial_ends_at`
// survives only as a nullable vestige that nothing sets). This page therefore no
// longer reads it and no longer passes a `trialDaysLeft` down — the old sub-copy
// would have rendered "your 30-day trial ends in 0 days" to every member forever.
//
// Nothing else about the member's row is read here: the price, and the remaining
// promotional allowance the screen displays, are decided SERVER-SIDE by
// /api/subscription/checkout from `subscription.promo_passes_used` and arrive with
// the clientSecret. Reading the counter here too would just create a second,
// drift-prone source of truth for a number that decides what someone is charged.
//
// An `active` member is deliberately NOT redirected away any more. The pass does
// not auto-renew, so paying again BEFORE expiry (early renewal) is a first-class
// flow, not an error — the route returns a renewal PaymentIntent and the screen
// switches to the extend copy. The old `status === "active" → /account` redirect
// (and the route's matching 409 already_active) were what made that impossible.
//
// The actual Stripe Customer/Subscription/PaymentIntent creation + Elements
// mount happens client-side in CheckoutForm (POSTs /api/subscription/checkout on
// mount) — this page never talks to Stripe directly.
import { CheckoutForm } from "./checkout-form";

export const metadata = { title: "Checkout · StablePass" };

export default function CheckoutPage() {
  return <CheckoutForm />;
}
