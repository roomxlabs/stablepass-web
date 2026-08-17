// Checkout screen (04-checkout.html) — embedded Stripe Elements, no hosted
// redirect (.rx/guardrails.md #4). Server component: reads trial_ends_at for the
// "trial ends in N days" sub-copy.
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
import { supabaseServer } from "@/lib/supabase/server";
import { CheckoutForm } from "./checkout-form";

export const metadata = { title: "Checkout · StablePass" };

function trialDaysLeft(trialEndsAt: string | null): number {
  if (!trialEndsAt) return 0;
  const ms = new Date(trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export default async function CheckoutPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  const userId = user!.id;

  const { data: sub } = await sb
    .from("subscription")
    .select("status,trial_ends_at")
    .eq("user_id", userId)
    .maybeSingle();

  return <CheckoutForm trialDaysLeft={trialDaysLeft(sub?.trial_ends_at ?? null)} />;
}
