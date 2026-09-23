// Checkout screen (04-checkout.html) — embedded Stripe Elements, no hosted
// redirect (.rx/guardrails.md #4).
//
// Pricing v2 (ENG-1328) brings back a one-time 30-day free trial, but this
// page still reads only `status`. Whether THIS member gets the trial is decided
// SERVER-SIDE by /api/subscription/checkout from their own
// `subscription.trial_used_at`, and arrives with the clientSecret (with the
// list price and what is due today). Reading it here too would just create a
// second, drift-prone source of truth for a flag that decides what someone is
// charged.
//
// An already-active member has nothing to buy: the membership auto-renews, so
// early renewal is gone. Redirect to /account (R4 owns managing a live sub).
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
