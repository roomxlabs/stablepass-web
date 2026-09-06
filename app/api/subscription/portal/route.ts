// GET /api/subscription/portal — Stripe Billing Portal session (ENG-1028).
//
// The portal is hosted by Stripe. We only ever hand back a redirect URL —
// card data never reaches this server (.rx/guardrails.md #4).
//
// The session MUST pin `STRIPE_PORTAL_CONFIGURATION_ID`. An unpinned session
// falls back to the account default, which may have cancellation enabled and
// would route members around `cancel_own_subscription()`, leaving `canceled_at`
// unwritten (the churn signal ENG-982 exists to show). If the id is unset we
// 502 rather than create that session.
//
// SELECT only on `subscription` — never `.update()`. Writes stay on the
// definer RPC / the webhook.
import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { supabaseServer } from "@/lib/supabase/server";
import { UNAUTH, fail } from "@/lib/api/envelope";

function returnUrl(req: Request): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (host) {
    const proto = req.headers.get("x-forwarded-proto") ??
      (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
    return `${proto}://${host}/account`;
  }
  return new URL("/account", req.url).toString();
}

export async function GET(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const stripe = getStripe();
  if (!stripe) return fail("stripe_unavailable", "Payment provider not configured.", 502);

  const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
  if (!configuration) {
    console.error(
      "[portal] STRIPE_PORTAL_CONFIGURATION_ID is unset — refusing to create an unpinned session",
    );
    return fail("stripe_error", "Payment provider unavailable.", 502);
  }

  const { data, error } = await sb
    .from("subscription")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error && error.code !== "PGRST116") {
    console.error(
      "[portal] subscription read failed (%s): %s",
      error.code ?? "no code",
      error.message ?? String(error),
    );
    return fail("stripe_error", "Payment provider unavailable.", 502);
  }

  const customerId =
    (data as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null;
  if (!customerId) {
    return fail("no_stripe_customer", "There's no billing account to manage yet.", 409);
  }

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl(req),
      configuration,
    });
    if (!session.url) {
      console.error("[portal] Billing Portal session had no url");
      return fail("stripe_error", "Payment provider unavailable.", 502);
    }
    return NextResponse.redirect(session.url, 302);
  } catch (err) {
    console.error(
      "[portal] billingPortal.sessions.create failed: %s",
      err instanceof Error ? err.message : String(err),
    );
    return fail("stripe_error", "Payment provider unavailable.", 502);
  }
}
