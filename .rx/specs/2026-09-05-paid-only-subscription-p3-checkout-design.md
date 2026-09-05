# ENG-1001 · P3 · web · Checkout picks A$9 or A$19 server-side

**Epic:** ENG-997 · **Base branch:** `feature/pricing-v1` · **Blocked by:** ENG-998, ENG-999

See `2026-09-05-paid-only-subscription-epic-design.md` for the model.

## Changes to `app/api/subscription/checkout/route.ts`

**1. Read the counter, choose the price.** Add `promo_passes_used` to the subscription select.

```ts
const PROMO_PASS_ALLOWANCE = 6;
const promoUsed = sub?.promo_passes_used ?? 0;
const priceId = promoUsed < PROMO_PASS_ALLOWANCE
  ? process.env.STRIPE_PRICE_ID_PROMO!
  : process.env.STRIPE_PRICE_ID_STANDARD!;
```

**The request body plays no part.** No parameter, header or query string can influence `priceId`
— it is derived from a server-side read of the member's own row. `?? 0` fails **toward the
discount**: if the read comes back null the member is charged less, not more. Getting that
backwards overcharges someone.

**2. Keep the no-literals rule.** `prices.retrieve(priceId)`; a null `unit_amount` stays a hard
`stripe_error` 502; `unitAmount`/`currency` are still echoed so the screen and the charge cannot
disagree. No amount literal enters this file.

**3. Fix the reuse filter — this is the mis-charge bug.** It currently matches
`item.price?.id === process.env.STRIPE_PRICE_ID`. With two prices that is wrong in both
directions: an exhausted member could have a stale A$9 pending Subscription reused
(**undercharged**), and a pending subscription at the other price fails the filter so a second
one is created. Match against **`priceId`**. Keep `newestFirst`, the `metadata.app_user_id`
check and the `cancel_at_period_end === true` check — those three re-assert what the create path
guarantees, and dropping any of them reintroduces ENG-582.

**4. Both branches** — first purchase and early-renewal top-up — use `priceId`. A top-up consumes
one of the six.

**5. Echo `promoRemaining`** so the screen can render honest copy. It may be *displayed*, never *sent*.

**6. Idempotency key** — `subCreateParams` now carries `priceId`, so a price change automatically
yields a fresh key. Do not "simplify" the digest away.

## Surface

```
app/api/subscription/checkout/route.ts
app/api/subscription/checkout/route.test.ts
app/(member)/checkout/checkout-form.tsx
app/(member)/checkout/page.tsx
```

Do NOT touch: `lib/api/access.ts`, `app/(member)/account/**`, `app/start/**`, `app/api/auth/**`,
`app/(marketing)/**`.

## Design

`dev-handover/StablePass-mockups/mockups/web/screens/04-checkout.html`.

⚠️ `.rx/mockups.md` points at `06-stage1-design/mockups/web/`, **which does not exist** —
verified 5 Sep 2026. The mockup shows a single price and has **no promo treatment**, so
rendering `promoRemaining` has no backing mockup: compose from existing tokens (the
`.trial-banner-web` family is the established informational band here) and flag the gap rather
than inventing a component.

## Guardrails

Card data never reaches our server — Elements only · `STRIPE_SECRET_KEY` server-only · **the
price is chosen server-side and is never client-influenced** · do **not** re-add
`sb.from("subscription").update(...)` — RLS denies it silently (0 rows, no error), which is
exactly the ENG-582 bug. The webhook is the only writer.

## Acceptance

counter 0 → A$9, `promoRemaining` 6 · 5 → A$9, remaining 1 · 6 → **A$19**, remaining 0 · 9 →
A$19 · a crafted body cannot force a price · renewal branch priced by the same counter · a stale
A$9 pending Subscription is **not** reused once on standard · one at the chosen price **is**
reused · two rapid loads return the same `subscriptionId` · no amount literal in the diff ·
`stripe_unavailable` and `stripe_error` still distinct (ENG-581).
