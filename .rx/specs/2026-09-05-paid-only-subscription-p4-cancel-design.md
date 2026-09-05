# ENG-1002 · P4 · web · Member cancel

**Epic:** ENG-997 · **Base branch:** `feature/pricing-v1` · **Blocked by:** ENG-999

See `2026-09-05-paid-only-subscription-epic-design.md` for the model.

`/api/subscription/cancel` existed once and was **deleted by ENG-567** when the pass became
non-renewing. This re-creates it with different semantics.

## 1. `POST /api/subscription/cancel` (new)

Calls `sb.rpc("cancel_own_subscription", { p_reason })`. **It must go through the RPC**:
`public.subscription` exposes only SELECT to `authenticated`, so a direct update matches zero
rows and returns no error — a silent no-op, exactly the ENG-582 bug.

Body `{ reason?: string }`, trimmed, blank treated as absent, >500 chars → 400
`validation_failed` before the RPC is called (the DB CHECK is the backstop, not the validator).
RPC `42501` → **409 `no_active_subscription`**, not 500. 401 unauthenticated.

**No Stripe call.** The Subscription already carries `cancel_at_period_end: true` and dies at its
own period end; `customer.subscription.deleted` is already guarded to lapse only once
`current_period_end` has elapsed.

200 → `{ status: "canceled", canceledAt, currentPeriodEnd }`.

## 2. `lib/api/access.ts` — mirror the new gate

The file's header says to keep this in lockstep with `has_content_access()`. ENG-999 moved the
DB side, so:

```ts
if (sub.status === "active" || sub.status === "canceled") {
  return sub.current_period_end === null || Date.parse(sub.current_period_end) > now;
}
return false;
```

Drop `trial_ends_at` from `ACCESS_COLUMNS` **only if** every reader is updated here — a select
that drifts from what the helper reads is invisible to `tsc` (`sb` is untyped) and fails closed
at runtime. Also refresh the stale header note claiming the deployed gate is still status-only;
that stopped being true when ENG-566 shipped.

## 3. `app/(member)/expiry-banner.tsx`

`expiryEndsAt()` always counts down to `current_period_end` now. Keep it calling `hasAccess()`
and keep it from re-deriving the entitlement rule — that separation is deliberate and documented
in the file.

## 4. `app/(member)/account/page.tsx`

Cancel control shown only when `hasAccess(sub) && sub.status === "active"`. Confirm step with an
optional free-text comment (max 500, counter shown); the text is member-authored — never rendered
as markup. New copy for `canceled`-but-entitled, using the existing `formatEndDate()` with its
pinned `Australia/Sydney` zone. Extend `statusPill()` **without** breaking its ENG-585 ordering:
entitlement is asked first, and the raw status only chooses between wordings. Remove the trial
wordings and `trialDaysLeft()` rather than leaving dead branches. **No price literal on this card.**

## Surface

```
app/api/subscription/cancel/route.ts             (new)
app/api/subscription/cancel/route.test.ts        (new)
app/(member)/account/page.tsx
app/(member)/account/cancel-card.tsx             (new client island)
app/(member)/expiry-banner.tsx
lib/api/access.ts
lib/api/access.test.ts
```

Do NOT touch: `app/api/subscription/checkout/**`, `app/(member)/checkout/**`, `app/start/**`,
`app/api/auth/**`, `app/(marketing)/**`, `content/legal/**`.

## Design

`dev-handover/StablePass-mockups/mockups/web/screens/09-account.html`.

⚠️ `.rx/mockups.md` path is stale — verified 5 Sep 2026. **The mockup has no cancel control and
no confirm dialog.** Compose from the existing token set and the patterns already on this screen,
the way `expiry-banner.tsx` reused `.trial-banner-web` rather than adding CSS. Flag the gap.

## Acceptance

Control visible only for active-entitled · cancel stamps `canceled_at` · **content still loads
after cancelling, to `current_period_end`** (verified against the real gate) · then 402 + wall ·
counter unchanged and a later purchase still priced from it · double-cancel 409 with
`canceled_at` intact · 501 chars → 400 · blank reason → null · card correct in all four states
including active-with-null-end · no "trial" wording · `hasAccess()` and `has_content_access()`
agree on all six status/date combinations.
