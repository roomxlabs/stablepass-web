import Stripe from "stripe";
import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

// POST /api/subscription/checkout — Customer + Subscription(incomplete) +
// PaymentIntent; return clientSecret for the embedded Payment Element. No redirect.
export async function POST() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();
  const { data: sub } = await sb.from("subscription").select("status,stripe_customer_id").eq("user_id", user.id).single();
  if (sub?.status === "active") return fail("already_active", "Already subscribed.", 409);
  try {
    // TODO(ticket): create/reuse Customer, create Subscription(incomplete) with the
    // ~A$19 price, expand latest_invoice.payment_intent, persist stripe_customer_id.
    const clientSecret = "pi_todo_client_secret";
    return ok({ clientSecret, publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY });
  } catch {
    return fail("stripe_unavailable", "Payment provider unavailable.", 502);
  }
}
