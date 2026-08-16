import { getStripe } from "@/lib/stripe";
import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";

// POST /api/subscription/checkout — the non-renewing 30-day pass.
//
// Two branches, one screen:
//  - Branch A (status !== "active"): first purchase / lapsed return. Creates a
//    Stripe Subscription with `cancel_at_period_end: true` SET AT CREATION —
//    that pre-armed cancel is the whole point: nothing auto-renews. Stripe still
//    needs a recurring price to make a Subscription; the cancel stops period 2.
//  - Branch B (status === "active"): early renewal. A one-off PaymentIntent.
//    Previously this returned 409 already_active; that rule is gone.
//
// The amount is NEVER hardcoded — `STRIPE_PRICE_ID` is the single source of
// truth for both amount and currency, retrieved on every request and echoed to
// the FE as `unitAmount`/`currency` so the screen and the charge can never
// disagree (sandbox is A$1.00, production A$19.00 — same code, no cutover edit).
//
// The card never touches our server (.rx/guardrails.md #4): we only create
// Stripe objects here and hand back a clientSecret for the FE to confirm inline.
// `STRIPE_SECRET_KEY` is server-only; only the publishable key crosses to the
// browser. This route NEVER writes `status='active'` — only the be webhook does.
//
// ERROR CODES (both 502) — the FE renders different copy per code, so they must
// stay distinct (ENG-581):
//  - `stripe_unavailable` — no STRIPE_SECRET_KEY at all. The designed
//    degradation (.rx/guardrails.md), and the ONLY code that may produce a
//    "payments are not configured" message on the screen.
//  - `stripe_error`       — the key works but Stripe failed (outage, bad price
//    id, rejected request). Reporting these as `stripe_unavailable` is what sent
//    a human hunting a misconfiguration that did not exist.

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

type SubscriptionRow = {
  status: string | null;
  stripe_customer_id: string | null;
  current_period_end: string | null;
};

// first_name / last_name / postcode are the identity split ENG-566 adds to
// `app_user` in the be repo. Until that migration lands the select errors and
// `data` is null — every field below is therefore read defensively and simply
// omitted from the Stripe Customer rather than blocking checkout.
type IdentityRow = {
  first_name: string | null;
  last_name: string | null;
  postcode: string | null;
};

export async function POST() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const stripe = getStripe();
  // getStripe() returns null by design when the key is unset — keeps `next
  // build` working with no Stripe env and keeps the screen's disabled
  // placeholder reachable. Never throw at module scope.
  if (!stripe) return fail("stripe_unavailable", "Payment provider not configured.", 502);

  const { data: subData } = await sb
    .from("subscription")
    .select("status,stripe_customer_id,current_period_end")
    .eq("user_id", user.id)
    .single();
  const sub = subData as SubscriptionRow | null;

  const { data: identityData } = await sb
    .from("app_user")
    .select("first_name,last_name,postcode")
    .eq("id", user.id)
    .maybeSingle();
  const identity = identityData as IdentityRow | null;

  try {
    // Resolve the price FIRST, in both branches. A failed retrieve or a null
    // unit_amount is a hard 502 — we never guess or fall back to a literal.
    const price = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID!);
    if (price?.unit_amount == null) {
      // NOT `stripe_unavailable` — the key is present and Stripe answered; the
      // price is simply unusable. See the error-code note above `POST`.
      console.error("[checkout] price %s has a null unit_amount", process.env.STRIPE_PRICE_ID);
      return fail("stripe_error", "Payment provider unavailable.", 502);
    }
    const unitAmount = price.unit_amount;
    const currency = price.currency;

    // The Stripe Customer carries identity: full name, AU postcode, and the
    // app_user_id the be webhook resolves the member by.
    const name = [identity?.first_name, identity?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    const postcode = identity?.postcode?.trim();
    // A member with no postcode (pre-existing account) must not be blocked — the
    // key is omitted entirely rather than sent as an empty string.
    const address = postcode ? { postal_code: postcode, country: "AU" } : undefined;

    let customerId = sub?.stripe_customer_id ?? null;
    if (customerId) {
      // Existing customer: refresh the identity rather than creating a second one.
      //
      // `address` is sent ONLY when we actually have a postcode. Stripe treats an
      // address hash on update as a FULL REPLACEMENT — sending a bare
      // `{ country: "AU" }` would null out whatever postal_code/line1/city Stripe
      // already holds for this customer, on every single checkout POST.
      await stripe.customers.update(customerId, {
        name: name || undefined,
        ...(address ? { address } : {}),
        metadata: { app_user_id: user.id },
      });
    } else {
      // On create there is nothing to overwrite, so country can be stated even
      // when the member has no postcode.
      customerId = (await stripe.customers.create({
        email: user.email,
        name: name || undefined,
        address: address ?? { country: "AU" },
        metadata: { app_user_id: user.id },
      })).id;
    }

    if (sub?.status === "active") {
      // ---- Branch B: early renewal -------------------------------------
      // Extend from the EXISTING end, never from today, so days already paid
      // for are never lost. The absolute value is stamped on the intent; the
      // be webhook applies it verbatim, which makes a redelivered event a
      // no-op. Do not let the webhook recompute it.
      const currentEndMs = Date.parse(sub.current_period_end ?? "");
      const base = Math.max(Number.isNaN(currentEndMs) ? Date.now() : currentEndMs, Date.now());
      const newPeriodEnd = Math.floor((base + THIRTY_DAYS_MS) / 1000);

      const intent = await stripe.paymentIntents.create({
        amount: unitAmount,
        currency,
        customer: customerId,
        automatic_payment_methods: { enabled: true },
        // REQUIRED — the be `stripe-webhook` fn resolves the subscriber by
        // app_user_id, and applies new_period_end as an absolute value.
        metadata: {
          app_user_id: user.id,
          kind: "renewal",
          new_period_end: String(newPeriodEnd),
        },
      });

      await sb.from("subscription").update({ stripe_customer_id: customerId }).eq("user_id", user.id);

      return ok({
        clientSecret: intent.client_secret ?? null,
        publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
        mode: "renewal",
        unitAmount,
        currency,
        // Echoed so the screen renders the AUTHORITATIVE dates rather than
        // recomputing (and potentially disagreeing with) them client-side.
        currentPeriodEnd: sub.current_period_end ?? null,
        newPeriodEnd: new Date(newPeriodEnd * 1000).toISOString(),
      });
    }

    // ---- Branch A: first purchase / lapsed return ----------------------
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env.STRIPE_PRICE_ID! }],
      payment_behavior: "default_incomplete",
      // The whole point — armed at creation so the pass never renews itself.
      cancel_at_period_end: true,
      // Stripe MOVED the first-purchase client secret. At this account's API
      // version (2026-06-24.dahlia) `Invoice.payment_intent` no longer exists —
      // it reads back absent, so the old single-path expand yielded a null
      // secret and Elements could never mount (ENG-581). The secret now lives on
      // `Invoice.confirmation_secret` = { type: "payment_intent", client_secret }.
      //
      // Both paths are requested together: verified accepted (HTTP 200) against
      // the live sandbox at 2026-06-24.dahlia, via raw REST and via stripe@22
      // itself. That is not Stripe ignoring junk — expand IS strictly validated
      // (an unknown path 400s with "This property cannot be expanded"), so
      // `latest_invoice.payment_intent` is still a recognised property here.
      //
      // Note it is defensive only: `lib/stripe.ts` calls `new Stripe(key)` with
      // no explicit apiVersion, so every request pins the SDK default and the
      // legacy branch cannot fire today. It is kept per the cross-version
      // precedent set by ENG-568/ENG-576. If a future Stripe release removes the
      // property outright this expand entry would 400 — the catch below now logs
      // loudly and returns `stripe_error`, so that would be visible, not silent.
      expand: ["latest_invoice.confirmation_secret", "latest_invoice.payment_intent"],
      // REQUIRED — the be `stripe-webhook` fn resolves the subscriber by this
      // metadata key. Do not rename/remove it.
      metadata: { app_user_id: user.id },
    });

    const latestInvoice = subscription.latest_invoice as {
      confirmation_secret?: { type?: string | null; client_secret?: string | null } | null;
      payment_intent?: { client_secret?: string | null } | null;
    } | null;
    // `confirmation_secret` is a tagged union. Today an incomplete Subscription
    // yields type "payment_intent", but a $0 invoice (100%-off coupon, credit
    // balance) yields a SetupIntent secret instead. Handing a `seti_…` secret to
    // Elements as a payment secret fails at confirmPayment, so only accept the
    // payment_intent variant (tolerating an absent `type` for forward-compat).
    const confirmation = latestInvoice?.confirmation_secret;
    const confirmationSecret =
      confirmation && (confirmation.type == null || confirmation.type === "payment_intent")
        ? confirmation.client_secret
        : null;
    // New position first, legacy second. `|| null` (not `??`) so an empty-string
    // secret normalises to null rather than serialising `clientSecret: ""`.
    const clientSecret = confirmationSecret || latestInvoice?.payment_intent?.client_secret || null;

    if (!clientSecret) {
      // A 200 carrying a null secret is precisely the failure that shipped
      // undetected: the Subscription is created, the route returns ok(), and the
      // screen renders a dead Pay button with no error anywhere. Never let that
      // pass silently again — this log is the tripwire.
      console.error(
        "[checkout] subscription %s created but no client secret found on latest_invoice (keys: %s)",
        subscription.id,
        latestInvoice && typeof latestInvoice === "object" ? Object.keys(latestInvoice).join(",") : String(latestInvoice),
      );
    }

    await sb.from("subscription").update({
      stripe_customer_id: customerId,
      stripe_subscription_id: subscription.id,
    }).eq("user_id", user.id);

    return ok({
      clientSecret,
      publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
      mode: "purchase",
      unitAmount,
      currency,
      subscriptionId: subscription.id,
    });
  } catch (err) {
    // Previously this swallowed every Stripe exception silently AND reported it
    // as `stripe_unavailable`, so an outage or a bad price id told a correctly
    // configured operator their key was missing — the same misdirection ENG-581
    // exists to remove. Now it is logged and carries a distinct code.
    console.error("[checkout] Stripe call failed", err);
    return fail("stripe_error", "Payment provider unavailable.", 502);
  }
}
