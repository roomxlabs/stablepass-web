# ENG-1001 — P3 · web · checkout picks the promo or standard price server-side

Part of ENG-997 (paid-only subscription). Base branch `feature/pricing-v1`.
Blocked by ENG-998 (the two price-id env vars) and ENG-999 (the
`subscription.promo_passes_used` column), both landed before this.

## The decision this route makes

`POST /api/subscription/checkout` decides what a member is charged. There are now
two prices — a promotional one for a member's first `PROMO_PASS_ALLOWANCE` (6)
passes, and a standard one after that.

```
promoUsed  = subscription.promo_passes_used ?? 0        // server-side read, own row
usePromo   = promoUsed < PROMO_PASS_ALLOWANCE
priceId    = usePromo ? STRIPE_PRICE_ID_PROMO : STRIPE_PRICE_ID_STANDARD
promoRemaining = max(0, PROMO_PASS_ALLOWANCE - promoUsed)
```

Three properties are load-bearing:

1. **The request body plays no part.** `export async function POST()` declares no
   `Request` parameter, so there is nothing to read — no field, header or query
   string can influence `priceId`. This is structural, not a validation rule, and
   the route test pins it (`POST.length === 0`) as well as asserting the chosen
   price at each counter value.
2. **`?? 0` fails toward the discount.** A null read (no row yet, or a column a
   deploy has not caught up with) charges the member *less*, never more. The
   counter is authoritative and the be `stripe-webhook` corrects state after the
   payment lands. Inverting the default would silently overcharge people.
3. **No amount literal in the route or the screen.** The chosen price id is
   retrieved on every request and `unitAmount`/`currency` are echoed to the FE, so
   the screen and the charge cannot disagree. A null `unit_amount` remains a hard
   `stripe_error` 502.

## The reuse filter — the mis-charge bug

Branch A adopts a member's already-pending `incomplete` Subscription instead of
stacking another (ENG-582). It used to match on a single ambient
`process.env.STRIPE_PRICE_ID`. With two prices that is wrong **in both
directions**:

* a member who has exhausted the allowance would have an old *promo-priced*
  pending Subscription adopted → **undercharged**;
* a pending Subscription at the *other* price fails the filter → a second one is
  quietly created, which is ENG-582 all over again.

The filter now matches `priceId` — the price chosen for *this* request. The other
three conditions are unchanged and all still required: `newestFirst` ordering (so
two loads resolve to the same object), `metadata.app_user_id === user.id` (without
it the webhook cannot resolve the payer — charged but never activated), and
`cancel_at_period_end === true` (without it we hand out an auto-renewing pass).

## Both branches are priced by the same counter

Branch A (first purchase / lapsed return) and Branch B (early-renewal top-up) both
use `priceId` and `unitAmount`. A top-up consumes one of the six — locked decision
— so it must not be fixed at the standard price.

## Idempotency

`idempotencyKey()` digests the request parameters into the key and is unchanged.
`subCreateParams` now carries `priceId`, so a member who crosses the threshold
between two visits inside the same 10-minute bucket automatically gets a fresh
key. Without the digest Stripe would replay the promo-priced Subscription and
undercharge them — do not "simplify" it away.

## Contract

`POST /api/subscription/checkout` → 200

```json
{ "clientSecret": "pi_..._secret_...", "publishableKey": "pk_...",
  "mode": "purchase" | "renewal", "unitAmount": 900, "currency": "aud",
  "promoRemaining": 5, "subscriptionId": "sub_..." }
```

Renewal additionally returns `currentPeriodEnd` and `newPeriodEnd`. Errors
unchanged, and the two 502s stay distinct (ENG-581): `stripe_unavailable` means
specifically "no `STRIPE_SECRET_KEY`" and is the only code that may render
"payments are not configured"; `stripe_error` means the key works and Stripe
failed.

`promoRemaining` is **display only**. The screen may show it; it may never send
it, and the route re-derives it from the DB on every request regardless.

## Screen

`app/(member)/checkout/` — `page.tsx` + `checkout-form.tsx`.

**Design source:** `dev-handover/StablePass-mockups/mockups/web/screens/04-checkout.html`.
Note `.rx/mockups.md` still points at a path that does not exist; the line above is
the real one (see `.rx/gotchas.md`).

The mockup has **no promo treatment** — it shows a single price and knows nothing
about an allowance. Rather than invent a component, the band composes the screen
family's established informational band, `.trial-banner-web` (soft green fill,
green left rule) with its `.trial-label` eyebrow and `.trial-detail` body — the
same pattern as `app/start/trial-used-wall.tsx` and
`app/(member)/expiry-banner.tsx`. Those two child classes are **scoped**
(`.trial-banner-web .trial-label`, not bare selectors), so they only style
correctly nested inside the parent. No new CSS, no new colour, no new radius.
**This is a copy addition with no backing mockup and is flagged as such on the PR.**

States:

| `promoRemaining` | Band |
|---|---|
| `> 1` | "Introductory pricing" · "This pass is {amount} — your introductory rate. {n} of your introductory passes are left at this price, this one included." |
| `1` | "Introductory pricing" · "…It is the last one at this price." |
| `0` | "Standard pricing" · "You've used all of your introductory passes. This pass is {amount}." |
| absent / not a number | nothing rendered |

The amount is always formatted from `unitAmount`/`currency`, so the band cannot
disagree with the order summary, the Pay button, or the charge.

### Trial copy removed

ENG-999 retired the free trial; `subscription.trial_ends_at` survives only as a
nullable vestige that nothing sets. The screen's old sub-copy ("Your 30-day trial
ends in N days") would therefore have rendered "…in 0 days" to every member
forever, so it is gone, along with `page.tsx`'s read of the column and the
`trialDaysLeft` prop. `page.tsx` no longer queries `subscription` at all — the
price and the allowance are decided by the route, and a second read here would be
a drift-prone duplicate source of truth for a number that decides what someone is
charged.

## Surface

```
app/api/subscription/checkout/route.ts
app/(member)/checkout/checkout-form.tsx
app/(member)/checkout/page.tsx
.rx/specs/2026-09-05-paid-only-subscription-p3-checkout-design.md
test/subscription-routes.test.ts          (the ticket says route.test.ts; this repo
                                           keeps route tests in test/, and this file
                                           already covers this route)
test/checkout-form.test.tsx
e2e/eng-1001-checkout-pricing.spec.ts     (new — screenshot evidence)
.rx/gotchas.md                            (append-only, the loop's learning file)
```

**Do NOT touch:** `lib/api/access.ts` · `app/(member)/account/**` ·
`app/(member)/expiry-banner.tsx` · `app/api/subscription/cancel/**` (ENG-1002 owns
these and runs concurrently) · `app/start/**` · `app/api/auth/**` ·
`app/(marketing)/**` · `app/globals.css`.

**Out of scope for this slice:** the cancel route and `/account` (P4) · `/start` and
signup (P5) · marketing copy (parked, ENG-1005) · `lib/api/access.ts` (P4) · the
webhook (P2) · removing `STRIPE_PRICE_ID` from Vercel (P0 keeps it set).

## Known conflict for a human to settle

The **epic** design's "Out of scope" list includes *"showing the member how many A$9
passes remain"* — but this slice's ticket (ENG-1001 §5 and its Surface note) explicitly
asks for `promoRemaining` to be echoed and rendered. The two specs disagree. This build
follows the ticket, because it is the specific and later instruction, and isolates the
treatment in a single `PromoBand` component with one call site so removing it is a
two-line change if the epic's line is the one that should win. Flagged on the PR.

## Guardrails held

* Card data never reaches our server — Elements only, confirmed client-side with
  the `clientSecret`; no card field is posted to any `/api/*` route. Unchanged.
* `STRIPE_SECRET_KEY` stays server-only; only the publishable key crosses.
* The price is chosen server-side from the database and is never
  client-influenced.
* No `sb.from("subscription").update(...)` was re-added. RLS denies it silently
  (0 rows, no error) — that is the ENG-582 bug. The webhook is the only writer.

## Tests

`test/subscription-routes.test.ts` — price selection at counter 0 / 5 / 6 / 9 and
at null, both branches, the reuse filter at each price (adopt at the matching
price, refuse at the other, in both directions), the metadata /
`cancel_at_period_end` re-assertions at the standard price, two sequential loads
returning the same `subscriptionId`, the body-cannot-influence-the-price guardrail,
401, and both distinct 502s.

`test/checkout-form.test.tsx` — the three band states, the absent and
non-numeric responses rendering no band, the scoped-selector nesting, no request
body, and no surviving trial copy.

`e2e/eng-1001-checkout-pricing.spec.ts` — screenshots of the promo and standard
states. The BFF is stubbed (no Stripe keys in this environment; see
`.rx/gotchas.md`) with non-catalogue amounts, deliberately, so a reintroduced
price literal in the component would be visible at a glance rather than silently
agreeing with the fixture.
