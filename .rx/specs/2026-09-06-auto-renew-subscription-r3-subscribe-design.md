# ENG-1027 · R3 · web · Checkout becomes subscribe

**Epic:** ENG-1022 · **Base branch:** `feature/pricing-v1` · **Blocked by:** ENG-1023, ENG-1025

## Changes to `app/api/subscription/checkout/route.ts`

1. **`cancel_at_period_end: false`** — one boolean, and it is the epic. Replace the comment above it
   (*"armed at creation so the pass never renews itself"*). Save the payment method as the default,
   or the first renewal has nothing to charge and everyone lapses in a month.
2. **One price, discount by coupon.** Always `STRIPE_PRICE_ID_STANDARD` (A$19);
   `coupon = intro_${6 - intro_months_used}` while any remain. `?? 0` fails **toward** the discount —
   a null read charges less, not more. The request body plays no part: a member must never be able
   to ask for `intro_6`. `STRIPE_PRICE_ID_PROMO` is no longer read.
3. **Delete Branch B entirely** — the active-member branch, the one-off PaymentIntent,
   `THIRTY_DAYS_MS`, `metadata.kind`, `new_period_end`, `mode: "renewal"` and its response fields.
   This deletes ENG-1007's idempotency key; leave that ticket `Done` as the record, do not revert it.
   An already-active member visiting `/checkout` is redirected to `/account`.
4. **The reuse filter inverts.** Keep `newestFirst`, the `metadata.app_user_id` check and the price
   check (dropping any reintroduces ENG-582), but a reusable pending subscription must now carry
   `cancel_at_period_end === false`. A leftover from the pass era carries `true` and must not be
   adopted, or the member gets a subscription that never renews.
5. **Response** reports the price and the discount separately (`unitAmount` 1900, `discountAmount`
   1000, `amountDueNow` 900) so the screen can honestly say "A$9.00 today, A$19.00 from March". The
   member is agreeing to both. Keep the `stripe_unavailable` / `stripe_error` split (ENG-581).

## Design

`dev-handover/StablePass-mockups/mockups/web/screens/04-checkout.html`.
⚠️ `.rx/mockups.md` path is stale — verified 5 Sep 2026. The mockup shows a **one-off purchase with
no recurring language at all**. Stating the recurring charge and the price-change date is a legal
and honesty requirement with no backing mockup: compose from existing tokens, flag the gap.

## Surface

```
app/api/subscription/checkout/route.ts
app/api/subscription/checkout/route.test.ts
app/(member)/checkout/checkout-form.tsx
app/(member)/checkout/page.tsx
```

## Acceptance

counter 0 → `intro_6`, due now 900 · 2 → `intro_4`, 900 · 6 → no coupon, **1900** · body cannot
change the coupon · no `mode: "renewal"` path remains · active member redirected · pending sub with
`true` not reused, with `false` reused · screen states the recurring charge and the change-over.
