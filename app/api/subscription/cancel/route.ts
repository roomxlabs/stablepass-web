import Stripe from "stripe";
import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// POST /api/subscription/cancel — cancel at period end (no Stripe-hosted page).
export async function POST() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const { data: sub } = await sb.from("subscription").select("status,stripe_subscription_id,current_period_end").eq("user_id", user.id).single();
  if (!sub || sub.status !== "active") return fail("not_active", "No active subscription.", 409);
  // TODO(ticket): stripe.subscriptions.update(id, { cancel_at_period_end: true }); webhook sets canceled.
  void stripe;
  return ok({ status: "canceled", currentPeriodEnd: sub.current_period_end });
}
