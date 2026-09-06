// Checkout screen (04-checkout.html) — embedded Stripe Elements, no hosted
// redirect (.rx/guardrails.md #4).
//
// There is no free trial any more (ENG-999 retired it). This page therefore
// does not read `trial_ends_at` and does not pass a `trialDaysLeft` down.
//
// An already-active member has nothing to buy: the pass now auto-renews, so
// early renewal is gone. Redirect to /account (R4 owns managing a live sub).
// Only `status` is read here — the coupon, the list price and the remaining
// intro months are decided SERVER-SIDE by /api/subscription/checkout from
// `subscription.intro_months_used` and arrive with the clientSecret. Reading
// the counter here too would just create a second, drift-prone source of truth
// for a number that decides what someone is charged.
//
// Do not import `lib/api/access.ts` or `readSubscriptionState` — those are
// R5 / shared entitlement, not this slice. A bare `status === "active"` is
// the redirect rule; a failed or missing row is treated as "not active" and
// the route fails closed if the same read later fails.
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { CheckoutForm } from "./checkout-form";

export const metadata = { title: "Checkout · StablePass" };

export default async function CheckoutPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (user) {
    const { data } = await sb
      .from("subscription")
      .select("status")
      .eq("user_id", user.id)
      .maybeSingle();
    if (data?.status === "active") redirect("/account");
  }
  return <CheckoutForm />;
}
