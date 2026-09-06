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

---

# As built (ENG-1002, 6 Sep 2026)

Decisions taken during the build, and where reality differed from the plan above.

## Envelope

The 200 payload is wrapped in the repo's standard envelope
(`lib/api/envelope.ts`, CLAUDE.md): `{ "data": { status, canceledAt,
currentPeriodEnd } }`, and errors are `{ "error": { code, message } }`. The
contract block above names the payload inside that wrapper, not a bare body —
every other route in this BFF is shaped the same way. Added one status the plan
did not name: **500 `cancel_failed`** for an RPC error that is not `42501`,
with fixed copy (never `error.message` — a constraint violation on this table
echoes the member's own free text back).

Also: a `reason` that is present but **not a string** is a 400
`validation_failed` rather than being silently ignored. Cancelling while
discarding whatever the caller thought they were sending is the worse failure.

## `ACCESS_COLUMNS` keeps `trial_ends_at`

The conditional in §2 resolves to **keep it**. `app/(member)/layout.tsx` still
reads `trial_ends_at` for the sidebar chip and is outside this slice's surface,
so narrowing the select below its reader would fail closed at runtime with
nothing to catch it. `AccessRow` keeps the field too; `hasAccess()` simply no
longer consults it. `test/member-layout.test.ts` pins this and stays green.

The stale header note in `access.ts` was refreshed as asked, and now records
that ENG-999 rewrote the DB side again — defence in depth is real, so the two
must not drift.

## Design gap — how the control was composed

The mockup has no cancel control and no confirm dialog (it was drawn when the
pass was trial-then-buy with nothing to cancel). Everything is composed from
what is already on this screen:

| Need | Reused from |
|---|---|
| idle control row | `.settings-row.notif-row` — the Notifications card's row shape |
| destructive button | `.btn.btn-light` + `var(--red)` — verbatim the Sign out treatment in `account-forms.tsx` |
| confirm panel | `.plan-card-inner` padding, `.input-label` + `.input`, `.form-error`, `.btn` |
| colours | `--line`, `--muted`, `--red`, `--brand-green` only |

**No modal.** This app has no dialog component family and adding one for a
single control would be designing rather than composing, so the confirm is an
in-card expansion — which also keeps the sentence naming the member's end date
on screen beside it. Inline styles are layout only, never treatment.

## Card states as shipped

| `status` | `current_period_end` | pill | plan meta | Cancel shown |
|---|---|---|---|---|
| `active` | future | Active (green) | Access to *date* | **yes** |
| `active` | null | Active (green) | Access active | no — see below |
| `active` | past | Ended (red) | Ended *date* | no |
| `canceled` | future | Access ending (green) | Access to *date* | no |
| `canceled` | past | Ended (red) | Ended *date* | no |
| `lapsed` | any | Ended (red) | Access ended / Ended *date* | no |

`canceled` + entitled is answered **inside** `statusPill()`'s `entitled` branch,
so the ENG-585 ordering is untouched. A `status === "canceled"` test placed
ahead of it would recreate that bug with the sign flipped — telling a member who
cancelled this morning, with 29 paid days left, that their access had ended.

Both entitled wordings stay **green**: the colour answers "do you have access",
true for both, and the wording carries "and it is winding down". A third state
colour would be a new treatment with no design reference.

`canCancel = entitled && status === "active" && current_period_end !== null`.
The status clause is the one place the raw status decides rather than chooses
words — legitimately, because the question is "is there an `active` row for the
RPC to cancel", not "does this member have access".

**The third clause is the subtle one, and it was added after review.**
`cancel_own_subscription()` stamps `current_period_end = coalesce(
current_period_end, now())` — deliberately, so a `canceled` row can always
expire (a `canceled` row with a null period would grant access forever and the
expiry sweep could never reach it). The consequence in the UI is that cancelling
during the just-paid / webhook-in-flight window revokes access **immediately**,
until the late webhook advances the period and restores it. The member would
click a control promising "you keep the days you've paid for" and land on
"Ended" plus the access wall — breaking this ticket's own acceptance criterion
that a cancelling member keeps content up to `current_period_end`. Verified
against the live database during review. The window is seconds long and nobody
needs to cancel inside it, so the control simply waits for the period to land.
This narrows the ticket's stated rule ("shown only when `hasAccess(sub) &&
status === 'active'`") — which is a necessary condition, so narrowing is
compatible with it.

The `entitled` clause also covers the `active`-but-EXPIRED row (the nightly
expiry sweep has not reached it yet): that member reads "Ended" everywhere else
on the card, so a Cancel button beside it would be a fresh ENG-585 bug. Both
states now have a test.

## Test locations differ from the declared surface

The surface lists colocated `app/api/subscription/cancel/route.test.ts` and
`lib/api/access.test.ts`. **This repo puts every test in `test/`** (69 files,
no colocated test anywhere), so they went to `test/cancel-route.test.ts`,
`test/cancel-card.test.tsx` and the existing `test/access.test.ts`. Flagged so
grill-me stops emitting colocated paths for this repo.

Tests updated beyond the declared surface, all of them tests **of files in the
surface** whose fixtures asserted retired trial behaviour:
`test/account-status-truth.test.tsx`, `test/expiry-banner.test.tsx`,
`test/account-page.test.tsx`, plus `e2e/eng-585-status-truth.spec.ts` (its
`status: 'trial'` seed is now rejected by the DB CHECK). `e2e/eng-1002-cancel.spec.ts`
is new — the screenshot + real-gate harness.

## Known follow-ups (out of this surface)

* `components/access-wall.tsx` still tells a member who never paid "Your free
  trial has ended". Stale post-ENG-999; needs its own ticket. The e2e spec
  asserts it as-is so that ticket landing turns this red.
* `e2e/expiry-banner.spec.ts` and `e2e/trial-start.spec.ts` seed trials through
  the signup flow and are dead until P5 reworks `/start`.
