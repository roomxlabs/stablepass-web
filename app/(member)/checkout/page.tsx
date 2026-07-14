// Checkout screen (04-checkout.html) — embedded Stripe Elements, no hosted
// redirect (.rx/guardrails.md #4). Server component: gates on subscription
// status (already active → nothing to buy, redirect to /account) and reads
// trial_ends_at for the "trial ends in N days" sub-copy. The actual Stripe
// Customer/Subscription/PaymentIntent creation + Elements mount happens
// client-side in CheckoutForm (POSTs /api/subscription/checkout on mount) —
// this page never talks to Stripe directly.
import { redirect } from "next/navigation";
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

  if (sub?.status === "active") redirect("/account");

  return <CheckoutForm trialDaysLeft={trialDaysLeft(sub?.trial_ends_at ?? null)} />;
}
