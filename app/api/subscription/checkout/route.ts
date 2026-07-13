import { getStripe } from "@/lib/stripe";
import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";

// POST /api/subscription/checkout — Customer + Subscription(incomplete) +
// PaymentIntent; return clientSecret for the embedded Payment Element. No redirect.
// The card never touches our server — we only create Stripe objects here and
// hand back the clientSecret for the FE to confirm inline.
export async function POST() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { data: sub } = await sb
    .from("subscription")
    .select("status,stripe_customer_id")
    .eq("user_id", user.id)
    .single();
  if (sub?.status === "active") return fail("already_active", "Already subscribed.", 409);

  const stripe = getStripe();
  if (!stripe) return fail("stripe_unavailable", "Payment provider not configured.", 502);

  try {
    const customerId = sub?.stripe_customer_id
      ?? (await stripe.customers.create({
        email: user.email,
        metadata: { app_user_id: user.id },
      })).id;

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env.STRIPE_PRICE_ID! }],
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.payment_intent"],
      // REQUIRED — the be `stripe-webhook` fn (B2) resolves the subscriber by
      // this metadata key. Do not rename/remove it.
      metadata: { app_user_id: user.id },
    });

    const latestInvoice = subscription.latest_invoice as { payment_intent?: { client_secret?: string | null } } | null;
    const clientSecret = latestInvoice?.payment_intent?.client_secret ?? null;

    await sb.from("subscription").update({
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
    }).eq("user_id", user.id);

    return ok({
      clientSecret,
      publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
      subscriptionId: subscription.id,
    });
  } catch {
    return fail("stripe_unavailable", "Payment provider unavailable.", 502);
  }
}
