import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";

// POST /api/subscription/checkout — auto-renewing monthly subscribe (ENG-1027).
//
// One branch: first purchase / lapsed return. Creates a Stripe Subscription
// that RENEWS (`cancel_at_period_end: false`) and saves the card as the default
// payment method so the first off-session renewal has something to charge.
//
// An already-active member has nothing to buy — 409 `already_active`. The
// /checkout page redirects them to /account (where R4 manages a live sub).
// Early renewal (Branch B: one-off PaymentIntent, `mode: "renewal"`,
// `THIRTY_DAYS_MS`, `metadata.kind`) is gone.
//
// PRICE + COUPON (ENG-1027) — always `STRIPE_PRICE_ID_STANDARD` (A$19). The
// introductory A$9 is a repeating coupon `intro_${remaining}` chosen HERE, on
// the server, from the member's own `subscription.intro_months_used`. The
// request body plays no part: this handler takes no `Request` argument at all,
// so there is no parameter, header or query string that can influence the
// coupon. A member can never ask for `intro_6`.
//
// `?? 0` / a non-numeric read fails TOWARD the discount — a null counter
// charges less, never more, and the webhook corrects the state. Inverting that
// default would silently overcharge someone.
//
// `STRIPE_PRICE_ID_PROMO` is no longer read. R0 leaves the env var set.
//
// The list price is NEVER hardcoded — `STRIPE_PRICE_ID_STANDARD` is retrieved
// on every request and echoed as `unitAmount`/`currency`. The discount is
// reported separately (`discountAmount` / `amountDueNow`) so the screen can
// honestly say both "A$9.00 today" and "then A$19.00". The change-over is
// remaining discounted invoices, not a calendar date — a cancel-and-return
// path would make any printed month wrong.
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
//    id, missing coupon, rejected request). Reporting these as
//    `stripe_unavailable` is what sent a human hunting a misconfiguration
//    that did not exist.
//  - `subscription_unavailable` (ENG-1001) — the member's `subscription` row
//    could not be READ, so we refuse to price a subscribe. Stripe was never
//    called. A third code for the same reason the two above are two.
//  - `already_active` (409) — they already have a live subscription.

const INTRO_MONTHS = 6;

type SubscriptionRow = {
  status: string | null;
  stripe_customer_id: string | null;
  intro_months_used: number | null;
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

// IDEMPOTENCY (ENG-582) ------------------------------------------------------
// This route CANNOT remember anything between requests. It reads
// `subscription.stripe_customer_id`, but it can never WRITE it: `public.subscription`
// carries only `subscription_select_self` / `subscription_select_admin` — both
// SELECT — because subscription writes are service-role-only by design. Only the
// be `stripe-webhook` persists these ids, and only AFTER a payment lands. So on
// every visit before the first successful payment the DB value is null, and the
// route must recover the member's existing Stripe objects from STRIPE ITSELF or
// it will create a fresh Customer + Subscription on every single page load
// (5 loads produced 5 of each in the live sandbox).
//
// Ordering rule for anything that can legitimately be duplicated: newest first,
// with the id as the tie-break. `created` is only second-granular, so two objects
// made in the same second would otherwise be free to come back in either order —
// and an UNSTABLE choice just moves the duplication problem instead of fixing it.
// Two successive loads must resolve to the same object.
function newestFirst<T extends { id: string; created: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// Look the member's Customer up in Stripe when our DB has not got it yet.
//
// `customers.list({ email })` is the PRIMARY lookup because it is STRONGLY
// consistent: verified against the live sandbox at 2026-06-24.dahlia, a Customer
// created at t+0 is returned by the very next list call.
//
// `customers.search` is NOT safe as the primary path. It is backed by an
// eventually-consistent index that measured a **36 second** lag on this account.
// Search is therefore the FALLBACK, and it runs whenever the email lookup cannot
// answer: no email on the auth record, or an email that has since changed.
//
// Members who visited /checkout before ENG-582 shipped already have several
// Customers under one `app_user_id`; that is pre-existing production data, not an
// edge case. We pick the NEWEST deterministically and never delete or merge the
// others — destroying payment records is not this route's job.
async function findExistingCustomer(
  stripe: Stripe,
  appUserId: string,
  email: string | undefined,
): Promise<Stripe.Customer | null> {
  if (email) {
    // NEVER call customers.list() without the email filter — an unfiltered list
    // returns other members' Customers, and picking one would cross-wire billing.
    const byEmail = await stripe.customers.list({ email, limit: 100 });
    // Match on the metadata this route stamps, so a shared/recycled email can
    // never hand this member a Customer belonging to a different app user.
    const mine = byEmail.data.filter((c) => c.metadata?.app_user_id === appUserId);
    if (mine.length > 0) return newestFirst(mine)[0];
  }

  const found = await stripe.customers.search({
    query: `metadata['app_user_id']:'${appUserId}'`,
    limit: 100,
  });
  // Re-check the metadata locally instead of trusting the query string to have
  // scoped the result. `appUserId` is a server-derived Supabase UUID and is never
  // request-controlled, so this is defence in depth rather than a live hole.
  return newestFirst(found.data.filter((c) => c.metadata?.app_user_id === appUserId))[0] ?? null;
}

// A deterministic idempotency key closes the only window `findExistingCustomer`
// cannot: two requests racing between the lookup and the create (a double click,
// or React StrictMode double-invoking the effect) both miss, and both create.
// Same key => Stripe returns the SAME Customer for the second one.
//
// The request body is digested INTO the key on purpose. Stripe rejects a reused
// key whose parameters differ (`idempotency_error`, confirmed live), and a
// member's name, postcode, or remaining intro months can legitimately change
// between visits — digesting gives each distinct body its own key. Genuinely
// concurrent requests read the same identity row and so produce the same digest.
// Stripe replays a key for 24h. The key is bucketed to 10 minutes so a deleted
// Customer or an expired `incomplete` Subscription cannot be replayed as a dead
// id / expired secret (ENG-581 from a new direction).
const IDEMPOTENCY_BUCKET_MS = 10 * 60 * 1000;

function idempotencyKey(scope: string, appUserId: string, body: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  const bucket = Math.floor(Date.now() / IDEMPOTENCY_BUCKET_MS);
  return `eng582-${scope}-${appUserId}-${bucket}-${digest}`;
}

export async function POST() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const stripe = getStripe();
  // getStripe() returns null by design when the key is unset — keeps `next
  // build` working with no Stripe env and keeps the screen's disabled
  // placeholder reachable. Never throw at module scope.
  if (!stripe) return fail("stripe_unavailable", "Payment provider not configured.", 502);

  // The `error` is captured, NOT discarded. This projection names
  // `intro_months_used`, a column the be ENG-1025 migration renames — and an
  // explicit PostgREST projection REJECTS THE WHOLE QUERY with `42703` if any
  // named column is not deployed (.rx/gotchas.md, ENG-617). Dropping the error
  // puts that failure in the same branch as "this member has no row yet":
  //   * `sub` is null, so `sub?.status === "active"` is false and an already-
  //     paying member would be sent down the subscribe path and charged again;
  //   * and none of it would be logged.
  // So this fails CLOSED. Nothing has been charged at this point, so a 502 is
  // strictly safer than proceeding on a row we know we failed to read.
  const { data: subData, error: subError } = await sb
    .from("subscription")
    .select("status,stripe_customer_id,intro_months_used")
    .eq("user_id", user.id)
    .single();
  // PGRST116 is `.single()`'s "no rows" — a legitimate state for a member who has
  // never had a subscription row, and the case every field below already reads
  // defensively. Only a DIFFERENT code means the read itself failed.
  if (subError && subError.code !== "PGRST116") {
    console.error(
      "[checkout] subscription read failed (%s) — refusing to price a subscribe from a row we could not read: %s",
      subError.code ?? "no code",
      subError.message ?? String(subError),
    );
    // Deliberately NOT `stripe_error`: the key is fine and Stripe was never
    // called. Conflating a failure with an unrelated one is exactly what ENG-581
    // exists to stop, so this carries its own code. The screen needs no change —
    // it already renders its generic "we couldn't start a secure payment,
    // nothing has been charged" state for any code that is not
    // `stripe_unavailable`, which is the correct copy here.
    return fail("subscription_unavailable", "Could not start checkout. Please try again shortly.", 502);
  }
  const sub = subData as SubscriptionRow | null;

  if (sub?.status === "active") {
    return fail("already_active", "You already have an active subscription.", 409);
  }

  // The coupon is chosen from the member's OWN row, server-side. The default
  // deliberately fails TOWARD the discount: if there is no row yet the member
  // is charged less, never more. The counter is authoritative and the be
  // `stripe-webhook` corrects the state after the payment lands.
  //
  // The guard is `Number.isFinite`, not bare `?? 0`: `?? 0` only catches null,
  // and a non-numeric value would make `remaining` 0 and skip the coupon —
  // the exact opposite of the stated invariant. The column is `int not null`
  // with a 0..1000 CHECK so this is not reachable today; it is written this
  // way so the guarantee holds by construction rather than by the schema
  // happening to agree.
  const rawUsed = sub?.intro_months_used;
  const used = typeof rawUsed === "number" && Number.isFinite(rawUsed) ? rawUsed : 0;
  const remaining = Math.max(0, INTRO_MONTHS - used);
  const coupon = remaining > 0 ? `intro_${remaining}` : undefined;

  const { data: identityData } = await sb
    .from("app_user")
    .select("first_name,last_name,postcode")
    .eq("id", user.id)
    .maybeSingle();
  const identity = identityData as IdentityRow | null;

  try {
    const priceId = process.env.STRIPE_PRICE_ID_STANDARD!;
    // Resolve the price FIRST. A failed retrieve or a null unit_amount is a
    // hard 502 — we never guess or fall back to a literal.
    const price = await stripe.prices.retrieve(priceId);
    if (price?.unit_amount == null) {
      // NOT `stripe_unavailable` — the key is present and Stripe answered; the
      // price is simply unusable. See the error-code note above `POST`.
      console.error("[checkout] price %s has a null unit_amount", priceId);
      return fail("stripe_error", "Payment provider unavailable.", 502);
    }
    const unitAmount = price.unit_amount;
    const currency = price.currency;

    // Discount comes from the Stripe coupon object, never a hardcoded 1000.
    // A missing / non-amount_off coupon is a Stripe failure, not a silent
    // full-price charge (that would overcharge someone we promised A$9).
    let discountAmount = 0;
    if (coupon) {
      const couponObj = await stripe.coupons.retrieve(coupon);
      if (typeof couponObj.amount_off !== "number") {
        console.error("[checkout] coupon %s has no amount_off", coupon);
        return fail("stripe_error", "Payment provider unavailable.", 502);
      }
      discountAmount = couponObj.amount_off;
    }
    const amountDueNow = Math.max(0, unitAmount - discountAmount);

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

    // Prefer the DB value — once the webhook has written it, it is authoritative
    // and costs no Stripe round-trip. Before the first payment it is always null
    // (see the IDEMPOTENCY note above), so fall back to asking Stripe.
    let customerId = sub?.stripe_customer_id ?? null;
    if (!customerId) {
      customerId = (await findExistingCustomer(stripe, user.id, user.email))?.id ?? null;
    }

    if (customerId) {
      // Existing customer: refresh the identity rather than creating a second one.
      //
      // `address` is sent ONLY when we actually have a postcode. Stripe treats an
      // address hash on update as a FULL REPLACEMENT — sending a bare
      // `{ country: "AU" }` would null out whatever postal_code/line1/city Stripe
      // already holds for this customer, on every single checkout POST.
      //
      // `email` is refreshed here too. Before ENG-582 this branch was DEAD — it
      // keyed off a `stripe_customer_id` that RLS guaranteed stayed null — so its
      // contents had never actually run. It is now the hot path, and the email is
      // no longer cosmetic: `customers.list({ email })` is the primary, strongly
      // consistent lookup, so letting it drift would permanently demote this
      // member to the 36s-stale search fallback (and send Stripe's receipts to
      // the old address). Unlike `address`, `email` is a scalar — updating it
      // replaces nothing else.
      await stripe.customers.update(customerId, {
        email: user.email,
        name: name || undefined,
        ...(address ? { address } : {}),
        metadata: { app_user_id: user.id },
      });
    } else {
      // On create there is nothing to overwrite, so country can be stated even
      // when the member has no postcode.
      const createParams: Stripe.CustomerCreateParams = {
        email: user.email,
        name: name || undefined,
        address: address ?? { country: "AU" },
        metadata: { app_user_id: user.id },
      };
      customerId = (await stripe.customers.create(createParams, {
        idempotencyKey: idempotencyKey("customer", user.id, createParams),
      })).id;
    }

    // Reuse the member's already-pending Subscription instead of stacking
    // another one (ENG-582). `subscriptions.list` is STRONGLY consistent —
    // verified live: a Subscription created at t+0 comes back from the very next
    // list call, already carrying a usable `confirmation_secret` — so a rapid
    // SEQUENTIAL second page load always sees the first one's work.
    //
    // Strong consistency does NOT close the CONCURRENT case: two overlapping
    // requests both list before either creates, so both miss. That is a
    // list-then-create TOCTOU, and it is closed by the idempotency key on the
    // create below — not by this lookup.
    //
    // Nothing is ever deleted here: Stripe expires an untouched `incomplete`
    // Subscription after ~23h, so stale ones fall out of this list by themselves.
    const pending = await stripe.subscriptions.list({
      customer: customerId,
      status: "incomplete",
      limit: 100,
      // Re-expanded so a REUSED Subscription hands back its CURRENT secret
      // rather than a remembered one — ENG-581's `confirmation_secret` read
      // applied to the reuse path. Both expand paths verified accepted (HTTP
      // 200) on the list endpoint at 2026-06-24.dahlia.
      expand: ["data.latest_invoice.confirmation_secret", "data.latest_invoice.payment_intent"],
    });
    // A member can legitimately hold several pending Subscriptions (anyone who
    // loaded /checkout before ENG-582 shipped does). Pick deterministically —
    // newest first, id as tie-break — so two loads in a row resolve to the SAME
    // Subscription instead of alternating between them.
    //
    // Adopting a Stripe object into the billing flow means re-asserting every
    // property the create path guarantees, not just the price. A subscription
    // made under this Customer by the Stripe dashboard, a support action, or a
    // leftover from the pass era would otherwise be reused with:
    //  - no `metadata.app_user_id` → the member pays, the be `stripe-webhook`
    //    cannot resolve the subscriber, and they are charged but never activated
    //    (silent, and the worst outcome in this file);
    //  - `cancel_at_period_end: true` → a pass-era leftover that NEVER renews.
    //    The create path now sets `false`; only `false` is reusable.
    //
    // The price match is against `priceId` — always STANDARD after ENG-1027.
    // `quantity` is checked alongside the price because the price alone does not
    // determine the CHARGE: a dashboard-created pending Subscription at the
    // right price with `quantity: 3` would be adopted, and we would report
    // `unitAmount` while Stripe charged three times it. The create path below
    // never sets a quantity (Stripe defaults it to 1), so `== null || === 1` is
    // exactly "what our own create path guarantees".
    const reusable =
      newestFirst(
        pending.data.filter(
          (s) =>
            s.items?.data?.some(
              (item) => item.price?.id === priceId && (item.quantity == null || item.quantity === 1),
            ) &&
            s.metadata?.app_user_id === user.id &&
            s.cancel_at_period_end === false,
        ),
      )[0] ?? null;

    const subCreateParams: Stripe.SubscriptionCreateParams = {
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      // The epic — the subscription renews. The card must also be saved as
      // the default, or the first off-session renewal has nothing to charge
      // and every member lapses in a month.
      cancel_at_period_end: false,
      payment_settings: { save_default_payment_method: "on_subscription" },
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
      // metadata key. Do not rename/remove it. Do not add `kind` — that was
      // the deleted early-renewal branch.
      metadata: { app_user_id: user.id },
      ...(coupon ? { discounts: [{ coupon }] } : {}),
    };

    // The list above closes the SEQUENTIAL race; this key closes the CONCURRENT
    // one. Two overlapping POSTs — a double click, two tabs, or React StrictMode
    // double-invoking the checkout screen's on-mount effect (which does not abort
    // its in-flight request) — both find nothing pending and both create. Same
    // key => Stripe returns the SAME Subscription to both.
    const subscription =
      reusable ??
      (await stripe.subscriptions.create(subCreateParams, {
        idempotencyKey: idempotencyKey("subscription", user.id, subCreateParams),
      }));

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
        "[checkout] subscription %s (%s) has no client secret on latest_invoice (keys: %s)",
        subscription.id,
        reusable ? "reused" : "created",
        latestInvoice && typeof latestInvoice === "object" ? Object.keys(latestInvoice).join(",") : String(latestInvoice),
      );
    }

    // DO NOT re-add a `sb.from("subscription").update(...)` here. RLS denies it
    // silently (0 rows, no error), which is exactly why `stripe_customer_id`
    // stayed null and this route stacked a Customer and a Subscription on every
    // visit (ENG-582). The be `stripe-webhook` writes both ids as service role
    // once a payment lands; that is the only supported write path.

    return ok({
      clientSecret,
      publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
      mode: "subscribe",
      unitAmount,
      discountAmount,
      amountDueNow,
      currency,
      introMonthsRemaining: remaining,
      // Never a calendar month: remaining intro months are paid invoices, and
      // a gap between subscriptions would make any derived date a lie.
      priceChangesOn: null,
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
