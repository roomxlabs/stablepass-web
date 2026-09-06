import { createHash } from "node:crypto";
import type Stripe from "stripe";
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
// PRICE SELECTION (ENG-1001) — there are now TWO prices: a promotional one for
// a member's first `PROMO_PASS_ALLOWANCE` passes and a standard one after that.
// Which one applies is decided HERE, on the server, from the member's own
// `subscription.promo_passes_used` counter. The request body plays no part: this
// handler takes no `Request` argument at all, so there is no parameter, header
// or query string that can influence the price. A member can never ask for the
// cheaper one.
//
// The amount is still NEVER hardcoded — the chosen price id is the single source
// of truth for both amount and currency, retrieved on every request and echoed
// to the FE as `unitAmount`/`currency` so the screen and the charge can never
// disagree. No amount literal appears in this file.
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
//  - `subscription_unavailable` (ENG-1001) — the member's `subscription` row could
//    not be READ, so we refuse to price a pass. Stripe was never called. It is a
//    third code for the same reason the two above are two: a DB failure reported
//    as a Stripe failure sends the next person debugging in the wrong direction.
//    The screen needs no change — anything that is not `stripe_unavailable`
//    already renders the generic "nothing has been charged" error state.

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// How many passes are sold at the promotional price before a member moves to
// the standard one. `promo_passes_used` counts EVERY paid pass (the be
// migration's wording), so the comparison is a simple `<`.
const PROMO_PASS_ALLOWANCE = 6;

type SubscriptionRow = {
  status: string | null;
  stripe_customer_id: string | null;
  current_period_end: string | null;
  promo_passes_used: number | null;
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
// The five duplicate Customers this ticket exists to stop were created 24s, 36s,
// 30s and ~38min apart — three of those gaps sit INSIDE that window, so a
// search-only fix would still have re-created the Customer.
//
// Search is therefore the FALLBACK, and it runs whenever the email lookup cannot
// answer: no email on the auth record, or an email that has since changed (the
// Customer is then still findable by metadata). Note that means it also runs — and
// harmlessly returns [] — on a brand-new member's first visit, which costs one
// extra Stripe round-trip on that one request. That is the deliberate trade: a
// stale index is still strictly better than no lookup, and it is never the only
// thing standing between us and a duplicate.
//
// Members who visited /checkout before this fix shipped already have several
// Customers under one `app_user_id`; that is pre-existing production data, not an
// edge case. We pick the NEWEST deterministically and never delete or merge the
// others — destroying payment records is not this route's job:
//   * the newest is the one whose name/postcode the pre-fix route refreshed last;
//   * it carries the freshest `incomplete` Subscription (Stripe expires those
//     after ~23h, so the oldest Customer's pending Subscription is the one most
//     likely to be gone, forcing yet another create);
//   * it is what the webhook will ultimately record, since it is the Customer the
//     member is about to pay against;
//   * and once reuse engages we stop creating, so "newest" stops moving.
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
  // request-controlled, so this is defence in depth rather than a live hole — but
  // it makes "this customer belongs to this member" a property of OUR code rather
  // than of Stripe's query parser, and it sidesteps the fact that Stripe's
  // metadata matching is case-insensitive.
  return newestFirst(found.data.filter((c) => c.metadata?.app_user_id === appUserId))[0] ?? null;
}

// A deterministic idempotency key closes the only window `findExistingCustomer`
// cannot: two requests racing between the lookup and the create (a double click,
// or React StrictMode double-invoking the effect) both miss, and both create.
// Same key => Stripe returns the SAME Customer for the second one.
//
// The request body is digested INTO the key on purpose. Stripe rejects a reused
// key whose parameters differ (`idempotency_error`, confirmed live), and a
// member's name or postcode can legitimately change between visits — digesting
// gives each distinct body its own key, so a profile edit can never turn into a
// hard 502. Genuinely concurrent requests read the same identity row and so
// produce the same digest, which is exactly the case being collapsed.
// Stripe replays a key for 24h. That is far longer than the race being closed
// (milliseconds) and long enough to do harm, so the key is bucketed to 10 minutes:
//   * if anyone deletes a duplicate Customer — the obvious cleanup after this
//     ticket — a 24h key would replay the cached create and hand back the id of a
//     DELETED customer, 502ing that member until the key aged out;
//   * Stripe expires an untouched `incomplete` Subscription at ~23h, so a 24h key
//     has a window where the list correctly misses the expired subscription, the
//     create replays, and we return an EXPIRED secret — reintroducing ENG-581's
//     dead Pay button from a new direction.
// Ten minutes is comfortably longer than a double-click or a StrictMode double
// effect (the only races that need collapsing) and far shorter than either hazard.
//
// Do NOT "simplify" the body digest away (ENG-1001). `subCreateParams` now carries
// the CHOSEN `priceId`, so a member who crosses the promo threshold between two
// visits inside the same 10-minute bucket automatically gets a fresh key — without
// the digest, Stripe would replay the promo-priced Subscription and undercharge them.
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
  // `promo_passes_used`, a column the be ENG-999 migration adds — and an explicit
  // PostgREST projection REJECTS THE WHOLE QUERY with `42703` if any named column
  // is not deployed (`.rx/gotchas.md`, ENG-617). Dropping the error puts that
  // failure in the same branch as "this member has no row yet", and the
  // consequences are far worse than a mispriced pass:
  //   * `sub` is null, so `sub?.status === "active"` is false and BRANCH B NEVER
  //     FIRES. An active member early-renewing would be sent down Branch A, get a
  //     new recurring Subscription with no `metadata.kind="renewal"` and no
  //     `metadata.new_period_end`, and the be webhook would then stamp
  //     `current_period_end = now + 30d` — DESTROYING the unexpired days they had
  //     already paid for.
  //   * and none of it would be logged.
  // So this fails CLOSED. Nothing has been charged at this point, so a 502 is
  // strictly safer than proceeding on a row we know we failed to read.
  const { data: subData, error: subError } = await sb
    .from("subscription")
    .select("status,stripe_customer_id,current_period_end,promo_passes_used")
    .eq("user_id", user.id)
    .single();
  // PGRST116 is `.single()`'s "no rows" — a legitimate state for a member who has
  // never had a subscription row, and the case every field below already reads
  // defensively. Only a DIFFERENT code means the read itself failed.
  if (subError && subError.code !== "PGRST116") {
    console.error(
      "[checkout] subscription read failed (%s) — refusing to price a pass from a row we could not read: %s",
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

  // The price is chosen from the member's OWN row, server-side (.rx/guardrails.md
  // — "the price is chosen server-side from the database and is never
  // client-influenced"). The default deliberately fails TOWARD the discount: if
  // there is no row yet the member is charged less, never more. The counter is
  // authoritative and the be `stripe-webhook` corrects the state after the
  // payment lands. Inverting this default would silently overcharge someone.
  //
  // The guard is `Number.isFinite`, not `?? 0`: `?? 0` only catches null, and a
  // non-numeric value would make `promoUsed < PROMO_PASS_ALLOWANCE` false and
  // charge the STANDARD price — the exact opposite of the stated invariant. The
  // column is `int not null` with a 0..1000 CHECK so this is not reachable today;
  // it is written this way so the guarantee holds by construction rather than by
  // the schema happening to agree.
  const rawPromoUsed = sub?.promo_passes_used;
  const promoUsed = typeof rawPromoUsed === "number" && Number.isFinite(rawPromoUsed) ? rawPromoUsed : 0;
  const usePromo = promoUsed < PROMO_PASS_ALLOWANCE;
  const priceId = usePromo
    ? process.env.STRIPE_PRICE_ID_PROMO!
    : process.env.STRIPE_PRICE_ID_STANDARD!;
  // Clamped at 0 because the counter keeps counting past the allowance — a
  // member on their tenth pass must read "0 left", not a negative number.
  const promoRemaining = Math.max(0, PROMO_PASS_ALLOWANCE - promoUsed);

  const { data: identityData } = await sb
    .from("app_user")
    .select("first_name,last_name,postcode")
    .eq("id", user.id)
    .maybeSingle();
  const identity = identityData as IdentityRow | null;

  try {
    // Resolve the price FIRST, in both branches. A failed retrieve or a null
    // unit_amount is a hard 502 — we never guess or fall back to a literal.
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

    if (sub?.status === "active") {
      // ---- Branch B: early renewal -------------------------------------
      // Extend from the EXISTING end, never from today, so days already paid
      // for are never lost. The absolute value is stamped on the intent; the
      // be webhook applies it verbatim, which makes a redelivered event a
      // no-op. Do not let the webhook recompute it.
      const currentEndMs = Date.parse(sub.current_period_end ?? "");
      const base = Math.max(Number.isNaN(currentEndMs) ? Date.now() : currentEndMs, Date.now());
      const newPeriodEnd = Math.floor((base + THIRTY_DAYS_MS) / 1000);

      // Branch A has two defences against creating a duplicate — the
      // `subscriptions.list` reuse lookup for the SEQUENTIAL race and an
      // `idempotencyKey` for the CONCURRENT one. Branch B had NEITHER: two tabs, or
      // a StrictMode double-effect, produced two full-price PaymentIntents carrying
      // the same absolute `new_period_end`, so confirming both was two charges for
      // one 30-day extension. The Pay button disables on first click
      // (checkout-form.tsx) but that only ever covered a single tab.
      //
      // ENG-1007 closes the CONCURRENT race with the key — the same defence Branch
      // A relies on for that case. It is deliberately NOT full parity: Branch A also
      // has the `subscriptions.list` reuse lookup for the SEQUENTIAL race, and
      // Branch B still has no equivalent, so the key is the only thing standing
      // here. A `paymentIntents.list`-and-adopt is the real second defence and is
      // left to a follow-up: adopting someone's existing intent safely needs the
      // same rigour Branch A's adopt path carries below (five separate
      // re-assertions — price, quantity, metadata, cancel_at_period_end), which is
      // a bigger design change than this bug's remit.
      //
      // The params are hoisted into a named const so the digest is taken over the
      // EXACT object sent to Stripe. That matters: Stripe rejects a reused key whose
      // parameters differ (`idempotency_error`), so a digest that drifted from the
      // payload would turn this fix into a 502. Digesting them also gives each
      // distinct charge its own key, which is what makes the collapse safe:
      //  * `amount`/`currency` — a member who crosses the promo threshold between
      //    two visits inside one bucket gets a fresh key rather than a replayed
      //    promo-priced intent (the Branch A note above, applied here);
      //  * `customer` — never collides across members (the key is user-scoped too);
      //  * `metadata.new_period_end` — the absolute extension. Two tabs on the same
      //    unchanged row derive the same value, so they collapse; once the first
      //    payment has landed and the webhook has advanced `current_period_end`, a
      //    genuine SECOND top-up derives a different value and is correctly allowed
      //    through rather than swallowed.
      //
      // The scope is `"renewal"` — distinct from Branch A's `"subscription"` and
      // from `"customer"` — so the branches can never hand Stripe the same key for
      // the same member in the same bucket.
      //
      // TWO RESIDUAL GAPS, both deliberately left open (ENG-1007). Naming them in
      // full because a partial list of known holes is worse than none — a later
      // reader will otherwise take this as the complete set.
      //
      // (1) The stale-period-end window. The collapse relies on `new_period_end`
      // being stable between two tabs, which holds whenever it is anchored to the
      // stored `current_period_end`. It does NOT hold when an `active` row carries a
      // null / unparseable / already-past one: the `Date.now()` fallback above then
      // advances, so two requests landing in different SECONDS (the value is floored
      // to 1s) derive different params and different keys, and both intents are
      // created. A StrictMode double-effect still collapses; two hand-opened tabs
      // may not.
      //   Do NOT read that as "corrupt data only". `lib/api/access.ts` treats
      //   `active` with a past `current_period_end` as a ROUTINE state — status is
      //   flipped when the be webhook lands, not at expiry, and ENG-585 shipped a
      //   user-visible bug in exactly that window. So the uncovered population is
      //   expired-active members mid-webhook — plausibly the most motivated Branch B
      //   visitors of all, since they are the ones clicking "pay again".
      //   It is still left open, because every cheap close is worse: quantising the
      //   fallback onto the bucket grid was tried and REVERTED (it moves a
      //   money-bearing date by up to 10 minutes and breaks the separately-tested
      //   guarantee that the fallback extends from NOW, never from a stale date),
      //   and quantising only the DIGEST while sending the true params is worse
      //   still — same key, different params is the one thing Stripe hard-rejects
      //   (`idempotency_error`), turning a rare double charge into a deterministic
      //   502 for members already in a bad state. The other option — refusing Branch
      //   B outright on a stale row — is a product decision, not a bug fix.
      //
      // (2) The bucket boundary. Two requests milliseconds apart can still straddle
      // a 10-minute bucket edge, get different keys, and both charge. Inherited from
      // the shared helper above; Branch A survives it because `subscriptions.list`
      // catches the sequential case, and Branch B has no such lookup (see above).
      //
      // Both are strictly narrower than what shipped before this change, which had
      // NO protection for ANY member. Neither is closed here rather than smuggling a
      // charge-semantics change into a bug fix — the same discipline ENG-1001 used
      // when it found this very gap and documented it instead.
      const intentCreateParams: Stripe.PaymentIntentCreateParams = {
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
      };
      const intent = await stripe.paymentIntents.create(intentCreateParams, {
        idempotencyKey: idempotencyKey("renewal", user.id, intentCreateParams),
      });

      // DO NOT re-add a `sb.from("subscription").update(...)` here. It was
      // removed in ENG-582 because it never worked and never could: `sb` is the
      // MEMBER's RLS-scoped client, and `public.subscription` exposes only
      // SELECT policies to `authenticated`. The update matched zero rows,
      // returned no error, and its result was unchecked — a silent no-op that
      // made this route look idempotent while it stacked a Customer per visit.
      // Persisting `stripe_customer_id` / `stripe_subscription_id` is the be
      // `stripe-webhook`'s job (it runs as service role). Giving the BFF a write
      // path here would break the service-role-only guardrail.

      return ok({
        clientSecret: intent.client_secret ?? null,
        publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
        mode: "renewal",
        unitAmount,
        currency,
        // Display only. The screen may SHOW this; it may never SEND it — the
        // route re-derives it from the DB on every request and ignores any body.
        promoRemaining,
        // Echoed so the screen renders the AUTHORITATIVE dates rather than
        // recomputing (and potentially disagreeing with) them client-side.
        currentPeriodEnd: sub.current_period_end ?? null,
        newPeriodEnd: new Date(newPeriodEnd * 1000).toISOString(),
      });
    }

    // ---- Branch A: first purchase / lapsed return ----------------------
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
    // loaded /checkout before this fix shipped does). Pick deterministically —
    // newest first, id as tie-break — so two loads in a row resolve to the SAME
    // Subscription instead of alternating between them.
    //
    // Adopting a Stripe object into the billing flow means re-asserting every
    // property the create path guarantees, not just the price. A subscription
    // made under this Customer by the Stripe dashboard, a support action, or a
    // future flow would otherwise be reused with:
    //  - no `metadata.app_user_id` → the member pays, the be `stripe-webhook`
    //    cannot resolve the subscriber, and they are charged but never activated
    //    (silent, and the worst outcome in this file);
    //  - `cancel_at_period_end: false` → we would silently hand them an
    //    AUTO-RENEWING pass, breaking the one rule the product is built on.
    //
    // The price match is against `priceId` — the price chosen for THIS request —
    // not against a single ambient env var (ENG-1001). With two prices in play a
    // fixed comparison is wrong in both directions: a member who has exhausted
    // the promo allowance would have their old promo-priced pending Subscription
    // adopted and be UNDERCHARGED, and a pending Subscription at the other price
    // would fail the filter and quietly stack a second one (ENG-582 again).
    // `quantity` is checked alongside the price because the price alone does not
    // determine the CHARGE: a dashboard- or support-created pending Subscription
    // at the right price with `quantity: 3` would be adopted, and we would report
    // `unitAmount` while Stripe charged three times it. The create path below
    // never sets a quantity (Stripe defaults it to 1), so `== null || === 1` is
    // exactly "what our own create path guarantees" — the same standard the
    // metadata and cancel_at_period_end checks are held to.
    const reusable =
      newestFirst(
        pending.data.filter(
          (s) =>
            s.items?.data?.some(
              (item) => item.price?.id === priceId && (item.quantity == null || item.quantity === 1),
            ) &&
            s.metadata?.app_user_id === user.id &&
            s.cancel_at_period_end === true,
        ),
      )[0] ?? null;

    const subCreateParams: Stripe.SubscriptionCreateParams = {
      customer: customerId,
      items: [{ price: priceId }],
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
    };

    // The list above closes the SEQUENTIAL race; this key closes the CONCURRENT
    // one. Two overlapping POSTs — a double click, two tabs, or React StrictMode
    // double-invoking the checkout screen's on-mount effect (which does not abort
    // its in-flight request) — both find nothing pending and both create. Same
    // key => Stripe returns the SAME Subscription to both.
    //
    // Without this, the Customer was collapsed by its own key while the
    // Subscription was not, so concurrent loads still stacked Subscriptions —
    // i.e. exactly the bug this ticket exists to kill, just harder to see.
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

    // DO NOT re-add a `sb.from("subscription").update(...)` here — see the note
    // in Branch B. RLS denies it silently (0 rows, no error), which is exactly
    // why `stripe_customer_id` stayed null and this route stacked a Customer and
    // a Subscription on every visit. The be `stripe-webhook` writes both ids as
    // service role once a payment lands; that is the only supported write path.
    //
    // A side effect worth naming (ENG-582): because the route now hands back the
    // SAME pending Subscription on every load, two open tabs can no longer pay
    // against different Subscriptions — so the webhook can no longer record a
    // `stripe_subscription_id` that differs from the one actually paid.

    return ok({
      clientSecret,
      publishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
      mode: "purchase",
      unitAmount,
      currency,
      // Display only — see the note on the renewal payload above.
      promoRemaining,
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
