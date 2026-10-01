import { createHash } from "node:crypto";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { supabaseServer } from "@/lib/supabase/server";
import { ok, UNAUTH, fail } from "@/lib/api/envelope";

// POST /api/subscription/checkout — auto-renewing monthly subscribe (ENG-1027),
// with a one-time 30-day free trial (Pricing v2, ENG-1328).
//
// One branch: first purchase / lapsed return. Creates a Stripe Subscription
// that RENEWS (`cancel_at_period_end: false`) and saves the card as the default
// payment method so the first off-session renewal has something to charge.
//
// An already-active member has nothing to buy — 409 `already_active`. The
// /checkout page redirects them to /account (where R4 manages a live sub).
//
// PRICE — always `STRIPE_PRICE_ID_STANDARD`, the ONE price (A$9.99 after O2).
// It is retrieved from Stripe on every request and echoed as
// `unitAmount`/`currency`; it is never hardcoded. There is no coupon and no
// intro discount any more: `intro_months_used` is not read, no coupon is
// retrieved or applied, and `STRIPE_PRICE_ID_PROMO` is not read.
//
// TRIAL — decided HERE, on the server, from the caller's OWN
// `subscription.trial_used_at` (the row is selected by the session user's id;
// this handler takes no `Request` argument, so no body, header or query string
// can pick whose row is read or ask for a trial):
//   * `trial_used_at` null (and no Subscription of theirs in Stripe has ever
//     trialled) → a 30-day free trial, CARD FIRST. The first POST returns a
//     SetupIntent secret (`intentType: "setup"`, A$0.00 due) and creates
//     nothing in Billing; once the screen has confirmed it, the next POST
//     creates the Subscription with `trial_period_days: 30` and that card as
//     `default_payment_method`, and answers `started: true`. Creating the trial
//     up front is NOT safe: Stripe marks its A$0.00 invoice paid at create, and
//     `invoice.paid` entitles the member — a page view would grant 30 days with
//     no card (measured in the Stripe sandbox 2026-09-23; see the trial branch).
//   * `trial_used_at` set → no trial: the full price is due now, confirmed as
//     a PaymentIntent (`intentType: "payment"`) — unchanged from ENG-1027.
// This route only READS `trial_used_at`. It is stamped once, by the be (B6,
// ENG-1327), never from here — two writers for an eligibility flag is how a
// member gets two free months. Eligibility is per StablePass ACCOUNT; it does
// not (cannot) stop a separate store trial under an Apple / Google ID.
//
// `priceChangesOn` is always null — the "then" line is a flat price, never a
// computed change-over date.
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
//    id, unset STRIPE_PRICE_ID_STANDARD, rejected request). Reporting these as
//    `stripe_unavailable` is what sent a human hunting a misconfiguration
//    that did not exist.
//  - `subscription_unavailable` (ENG-1001) — the member's `subscription` row
//    could not be READ, so we refuse to price a subscribe. Stripe was never
//    called. A third code for the same reason the two above are two.
//  - `already_active` (409) — they already have a live subscription, in our
//    row OR in Stripe (trialing / active / past_due) ahead of the webhook.

// The trial length Stripe is asked for. Not a price: what the member is charged
// always comes from the retrieved Stripe price / invoice.
const TRIAL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Tags the SetupIntents this route makes to start a trial, so a confirmed one
// is recognised on the next POST and nothing else under the Customer is.
const TRIAL_SETUP_PURPOSE = "stablepass_trial";

// A SetupIntent still waiting on the member — safe to hand back again.
const SETUP_REUSABLE_STATUSES = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);

// Stripe states in which a Subscription already gives (or is about to give)
// this member access. Any of these → 409, never a second Subscription.
const LIVE_STRIPE_STATUSES = new Set(["trialing", "active", "past_due"]);

// `latest_invoice.amount_due` when Stripe expanded it as a finite number.
function invoiceAmountDue(subscription: Stripe.Subscription): number | null {
  const due = (subscription.latest_invoice as { amount_due?: unknown } | null)?.amount_due;
  return typeof due === "number" && Number.isFinite(due) ? due : null;
}

type SubscriptionRow = {
  status: string | null;
  stripe_customer_id: string | null;
  trial_used_at: string | null;
};

type ClientSecretInfo = { clientSecret: string | null; intentType: "payment" | "setup" | null };

// Pull the secret the FE must confirm, and WHICH kind it is — Elements'
// `confirmPayment` rejects a SetupIntent secret and `confirmSetup` rejects a
// PaymentIntent one, so the type travels with the secret.
//
// Order: the invoice's `confirmation_secret` (a tagged union — a PaymentIntent
// for a charged first invoice; tolerate an absent `type` for forward-compat, and
// accept a `setup_intent` variant should Stripe ever put one there), then the
// legacy `latest_invoice.payment_intent`, then the Subscription's
// `pending_setup_intent` (defensive: this route never creates a card-less trial,
// but a trialing Subscription's card is collected there, never on its A$0.00
// already-paid invoice).
// `|| null` (not `??`) so an empty-string secret normalises to null.
function readClientSecret(subscription: Stripe.Subscription): ClientSecretInfo {
  const latestInvoice = subscription.latest_invoice as {
    confirmation_secret?: { type?: string | null; client_secret?: string | null } | null;
    payment_intent?: { client_secret?: string | null } | null;
  } | null;
  const confirmation = latestInvoice?.confirmation_secret;
  if (confirmation?.client_secret) {
    if (confirmation.type == null || confirmation.type === "payment_intent") {
      return { clientSecret: confirmation.client_secret, intentType: "payment" };
    }
    if (confirmation.type === "setup_intent") {
      return { clientSecret: confirmation.client_secret, intentType: "setup" };
    }
  }
  const legacy = latestInvoice?.payment_intent?.client_secret;
  if (legacy) return { clientSecret: legacy, intentType: "payment" };
  const pendingSetup = subscription.pending_setup_intent as { client_secret?: string | null } | string | null;
  const setupSecret = pendingSetup && typeof pendingSetup === "object" ? pendingSetup.client_secret : null;
  if (setupSecret) return { clientSecret: setupSecret, intentType: "setup" };
  return { clientSecret: null, intentType: null };
}

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
// member's name, postcode, or trial eligibility can legitimately change
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
  // `trial_used_at`, a column only the be ENG-1323 migration adds — and an
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
    .select("status,stripe_customer_id,trial_used_at")
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

  // Trial eligibility, from the member's OWN row (selected by `user.id` above).
  // No row yet = never trialled = eligible. Any non-null stamp = ineligible.
  const trialEligible = (sub?.trial_used_at ?? null) === null;

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

    // Every Subscription this member holds under the Customer, in ANY state
    // (ENG-582 reuse + ENG-1328 double-trial / double-charge guards).
    // `subscriptions.list` is STRONGLY consistent — verified live: a
    // Subscription created at t+0 comes back from the very next list call — so a
    // rapid SEQUENTIAL second page load always sees the first one's work. The
    // CONCURRENT case (both list before either creates) is closed by the
    // idempotency keys on the creates below, not by this lookup.
    //
    // Nothing is ever deleted here: Stripe expires an untouched `incomplete`
    // Subscription after ~23h, so stale ones fall out by themselves.
    //
    // Only Subscriptions carrying OUR `metadata.app_user_id` count: one made by
    // the dashboard / support without it is never adopted (the be webhook could
    // not resolve the member — charged but never activated).
    const listed = await stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
      // Re-expanded so a REUSED Subscription hands back its CURRENT secret
      // rather than a remembered one (ENG-581). Verified accepted (HTTP 200) on
      // the list endpoint at 2026-06-24.dahlia.
      expand: ["data.latest_invoice.confirmation_secret", "data.latest_invoice.payment_intent"],
    });
    const mine = listed.data.filter((s) => s.metadata?.app_user_id === user.id);

    // A LIVE Subscription in Stripe means this member already has (or is about
    // to have) access, even when the webhook has not reached our row yet: a
    // running trial, a just-paid membership, a cancelled-but-still-running one,
    // or a failed renewal (fixed from /account, not by buying a second one).
    // Creating another here would be a second trial or a double charge.
    if (mine.some((s) => LIVE_STRIPE_STATUSES.has(s.status))) {
      return fail("already_active", "You already have an active subscription.", 409);
    }

    // Trial eligibility is the member's OWN `trial_used_at` (read above) — AND,
    // as defence in depth for when that stamp has not landed, no Subscription of
    // theirs has ever had a trial in Stripe. Neither check writes anything.
    const offerTrial = trialEligible && !mine.some((s) => s.trial_start != null);

    if (offerTrial) {
      // ── TRIAL: CARD FIRST ──────────────────────────────────────────────────
      // Stripe marks a trial's A$0.00 first invoice `paid` the instant the
      // Subscription is CREATED, and `invoice.paid` is what entitles the member
      // (be stripe-webhook → RevenueCat → B6, which also stamps trial_used_at).
      // Creating the trial on page load would therefore hand out 30 days of
      // access — and burn the trial — before any card was entered. So:
      //   1. no confirmed card yet → return a SetupIntent (`usage: off_session`)
      //      for Elements' `confirmSetup`; nothing is created in Billing;
      //   2. the screen confirms it, then POSTs here again;
      //   3. a SUCCEEDED trial SetupIntent → create the trial Subscription with
      //      that card as `default_payment_method` (so day 30 charges it) and
      //      answer `started: true`.
      // Verified against the Stripe sandbox 2026-09-23: step 3 returns
      // `trialing`, `default_payment_method` = the SetupIntent's card, and an
      // A$0.00 `paid` first invoice.
      const intents = await stripe.setupIntents.list({ customer: customerId, limit: 100 });
      const trialIntents = intents.data.filter(
        (si) => si.metadata?.app_user_id === user.id && si.metadata?.purpose === TRIAL_SETUP_PURPOSE,
      );
      const confirmed = newestFirst(trialIntents.filter((si) => si.status === "succeeded" && si.payment_method))[0];

      if (confirmed) {
        const paymentMethod =
          typeof confirmed.payment_method === "string" ? confirmed.payment_method : confirmed.payment_method!.id;
        const trialParams: Stripe.SubscriptionCreateParams = {
          customer: customerId,
          items: [{ price: priceId }],
          default_payment_method: paymentMethod,
          // Renews: the first A$… charge lands when the trial ends.
          cancel_at_period_end: false,
          trial_period_days: TRIAL_DAYS,
          // REQUIRED — the be `stripe-webhook` resolves the subscriber by this.
          metadata: { app_user_id: user.id },
        };
        // Keyed on the SetupIntent, NOT time-bucketed: one confirmed card can
        // start at most one trial however many times this is POSTed. (After
        // Stripe's 24h key window the LIVE / `trial_start` checks above stop it.)
        const trial = await stripe.subscriptions.create(trialParams, {
          idempotencyKey: `eng1328-trial-${user.id}-${confirmed.id}`,
        });
        return ok({
          started: true,
          clientSecret: null,
          intentType: null,
          publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
          mode: "subscribe",
          unitAmount,
          amountDueNow: invoiceAmountDue(trial) ?? 0,
          currency,
          trialEndsAt: typeof trial.trial_end === "number" ? new Date(trial.trial_end * 1000).toISOString() : null,
          priceChangesOn: null,
          subscriptionId: trial.id,
        });
      }

      const reusableIntent = newestFirst(trialIntents.filter((si) => SETUP_REUSABLE_STATUSES.has(si.status)))[0];
      const setupParams: Stripe.SetupIntentCreateParams = {
        customer: customerId,
        usage: "off_session",
        // Card only (wallets such as Apple / Google Pay are cards too). Left to
        // the account's automatic config the sandbox offered Pix, Klarna,
        // Bancontact and Satispay here — redirect / non-recurring methods that
        // cannot carry an off-session A$ renewal on day 30.
        payment_method_types: ["card"],
        metadata: { app_user_id: user.id, purpose: TRIAL_SETUP_PURPOSE },
      };
      const setupIntent =
        reusableIntent ??
        (await stripe.setupIntents.create(setupParams, {
          idempotencyKey: idempotencyKey("trial-setup", user.id, setupParams),
        }));
      if (!setupIntent.client_secret) {
        console.error("[checkout] trial SetupIntent %s has no client secret", setupIntent.id);
      }
      return ok({
        started: false,
        clientSecret: setupIntent.client_secret || null,
        intentType: "setup",
        publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
        mode: "subscribe",
        unitAmount,
        // Nothing is charged to start a trial.
        amountDueNow: 0,
        currency,
        // PROJECTED for display ("free until …"): the trial is created the moment
        // the card is confirmed, and Stripe ends it TRIAL_DAYS after that.
        trialEndsAt: new Date(Date.now() + TRIAL_DAYS * DAY_MS).toISOString(),
        priceChangesOn: null,
        subscriptionId: null,
      });
    }

    // ── NO TRIAL: the full price is due now ─────────────────────────────────
    // Reuse the member's already-pending Subscription instead of stacking
    // another (ENG-582). Pick deterministically — newest first, id as
    // tie-break — so two loads in a row resolve to the SAME Subscription.
    //
    // Adopting a Stripe object into the billing flow means re-asserting every
    // property the create path guarantees, not just the price:
    //  - `metadata.app_user_id` (already required by `mine`);
    //  - `cancel_at_period_end: false` — a pass-era leftover NEVER renews;
    //  - the price AND `quantity` — a dashboard-created pending Subscription at
    //    the right price with `quantity: 3` would be adopted while we reported
    //    `unitAmount` and Stripe charged three times it. The create path never
    //    sets a quantity (Stripe defaults it to 1).
    const reusable =
      newestFirst(
        mine.filter(
          (s) =>
            s.status === "incomplete" &&
            s.items?.data?.some(
              (item) => item.price?.id === priceId && (item.quantity == null || item.quantity === 1),
            ) &&
            s.cancel_at_period_end === false,
        ),
      )[0] ?? null;

    const subCreateParams: Stripe.SubscriptionCreateParams = {
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: "default_incomplete",
      // The subscription renews. The card must also be saved as the default, or
      // the first off-session renewal has nothing to charge.
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
      //
      expand: ["latest_invoice.confirmation_secret", "latest_invoice.payment_intent"],
      // REQUIRED — the be `stripe-webhook` fn resolves the subscriber by this
      // metadata key. Do not rename/remove it. Do not add `kind` — that was
      // the deleted early-renewal branch.
      metadata: { app_user_id: user.id },
    };

    // The list above closes the SEQUENTIAL race; this key closes the CONCURRENT
    // one. Two overlapping POSTs — a double click, two tabs, or React StrictMode
    // double-invoking the checkout screen's on-mount effect — both find nothing
    // pending and both create. Same key => Stripe returns the SAME Subscription.
    const subscription =
      reusable ??
      (await stripe.subscriptions.create(subCreateParams, {
        idempotencyKey: idempotencyKey("subscription", user.id, subCreateParams),
      }));

    const { clientSecret, intentType } = readClientSecret(subscription);

    if (!clientSecret) {
      // A 200 carrying a null secret is precisely the failure that shipped
      // undetected (ENG-581): the route returns ok() and the screen renders a
      // dead Pay button with no error anywhere. This log is the tripwire.
      console.error(
        "[checkout] subscription %s (%s, status %s) has no client secret on latest_invoice (invoice keys: %s)",
        subscription.id,
        reusable ? "reused" : "created",
        subscription.status,
        subscription.latest_invoice && typeof subscription.latest_invoice === "object"
          ? Object.keys(subscription.latest_invoice).join(",")
          : String(subscription.latest_invoice),
      );
    }

    // DO NOT re-add a `sb.from("subscription").update(...)` here. RLS denies it
    // silently (0 rows, no error), which is exactly why `stripe_customer_id`
    // stayed null and this route stacked a Customer and a Subscription on every
    // visit (ENG-582). The be `stripe-webhook` writes both ids as service role
    // once a payment lands; that is the only supported write path. The same
    // goes for `trial_used_at` — the be (B6) is its only writer.

    return ok({
      started: false,
      clientSecret,
      intentType,
      publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
      mode: "subscribe",
      unitAmount,
      // What is due today is read from Stripe's own first invoice, never
      // computed from a literal; the retrieved list price if it is absent.
      amountDueNow: invoiceAmountDue(subscription) ?? unitAmount,
      currency,
      trialEndsAt: null,
      // Always null — the "then" line is a flat price, never a computed date.
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
