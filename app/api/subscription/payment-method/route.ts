import { getStripe } from "@/lib/stripe";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";

// POST /api/subscription/payment-method — SetupIntent so the member can update
// their card inline via the same embedded Elements form. (Optional per the ticket.)
export async function POST() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const stripe = getStripe();
  if (!stripe) return fail("stripe_unavailable", "Payment provider not configured.", 502);

  const { data: sub } = await sb
    .from("subscription")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .single();

  try {
    const setupIntent = await stripe.setupIntents.create({
      customer: sub?.stripe_customer_id ?? undefined,
      metadata: { app_user_id: user.id },
    });
    return ok({ clientSecret: setupIntent.client_secret });
  } catch {
    return fail("stripe_unavailable", "Payment provider unavailable.", 502);
  }
}
