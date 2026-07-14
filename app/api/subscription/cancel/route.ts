import { getStripe } from "@/lib/stripe";
import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";

// POST /api/subscription/cancel — cancel at period end (no Stripe-hosted page).
// The webhook flips `status` to canceled when the period actually ends; access
// is retained until `current_period_end`.
export async function POST() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { data: sub } = await sb
    .from("subscription")
    .select("status,stripe_subscription_id,current_period_end")
    .eq("user_id", user.id)
    .single();
  if (!sub || sub.status !== "active") return fail("not_active", "No active subscription.", 409);

  const stripe = getStripe();
  if (!stripe) return fail("stripe_unavailable", "Payment provider not configured.", 502);

  try {
    await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
    return ok({ status: "canceled", currentPeriodEnd: sub.current_period_end });
  } catch {
    return fail("stripe_unavailable", "Payment provider unavailable.", 502);
  }
}
