# ENG-1028 · R4 · web · /account, Billing Portal, and cancel that tells Stripe

**Epic:** ENG-1022 · **Base branch:** `feature/pricing-v1` · **Blocked by:** ENG-1023, ENG-1025

## 1. Cancel must tell Stripe

`cancel_own_subscription()` only writes our row. Without the Stripe call **the subscription keeps
renewing and the member keeps being charged** while our UI says cancelled — the worst bug this epic
could ship.

**Stripe first, then the RPC.** A Stripe failure returns 502 with nothing written: the member is
still subscribed and still billed, which is true and recoverable. The reverse order can leave our
row `canceled` while Stripe bills on — silent and expensive. If there is no `stripe_subscription_id`,
skip the Stripe call rather than throwing and still run the RPC.

The webhook later receives `customer.subscription.updated` and writes the same state (R2). That
duplication is intended; do not remove either writer.

## 2. `GET /api/subscription/portal`

Creates a Billing Portal session and redirects. **Pin `STRIPE_PORTAL_CONFIGURATION_ID`** — without
it Stripe falls back to the account default, which may allow cancellation, routing members around
our RPC and leaving `canceled_at` unwritten (breaking ENG-982's churn signal). 401 unauth; 409 with
no `stripe_customer_id`; the same two 502 codes as checkout.

## 3. The Subscription card

Next charge date and amount, when the price changes to A$19, manage-card, cancel. For a lapsed
member: a subscribe CTA, and on a failed renewal a "your payment didn't go through" message linking
to the portal rather than a generic "access ended".

Remove every "buy days" string — `"Extend access"`, `"Buy 30 days"`, `"30-day pass"`, and the copy
about access not renewing. All false now. Keep `statusPill()` deriving from **entitlement first**
(ENG-585) and `formatEndDate()`'s pinned `Australia/Sydney`. If the change-over date cannot be
derived confidently, say "then A$19.00 per month" without a date rather than printing a wrong one.

## Design

`dev-handover/StablePass-mockups/mockups/web/screens/09-account.html`.
⚠️ Stale manifest path. The mockup has **no next-charge line, no manage-card button, no cancel
control** — compose from `.settings-card` / `.btn`, no new component family. Flag the gap.

## Surface

```
app/api/subscription/cancel/route.ts + test
app/api/subscription/portal/route.ts + test     (new)
app/(member)/account/page.tsx
app/(member)/account/cancel-card.tsx
```

## Acceptance

Stripe called before the RPC; a Stripe failure writes nothing · after cancelling the **Stripe**
subscription carries `cancel_at_period_end: true` · content still loads to the period end · portal
pins the configuration and shows no cancel · no `stripe_customer_id` → 409 not 500 · card shows next
charge + change-over · payment-failed state links to the portal · no "buy days" copy remains.
