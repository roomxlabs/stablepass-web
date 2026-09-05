# ENG-1003 · P5 · web · Trial out of the funnel

**Epic:** ENG-997 · **Base branch:** `feature/pricing-v1` · **Blocked by:** ENG-999

See `2026-09-05-paid-only-subscription-epic-design.md` for the model.

`stablepass.co` is **live** and every CTA points at `/start`, which today creates a free 30-day
trial. This is the slice that stops that, and the only place in the member app that still says
"30 days free".

## Changes

**`app/start/page.tsx`** — title, aside quote (*"30 days on us — no credit card, no
auto-charge…"*) and the whole `?trial=used` branch go. Keep the replacement quote **short**: this
column has no mobile breakpoint and clips badly on a phone (recorded in `.rx/gotchas.md`), which
is why ENG-763's replacement was deliberately shorter than the original. With the wall gone there
is only one state, which removes the aside-disagrees-with-the-form hazard the header warns about.

**`app/start/trial-start-form.tsx`** — heading and button copy; delete the `trial_already_used`
branch and the `router.replace("/start?trial=used")`. **On success redirect to `/checkout`**, not
the feed.

**`app/start/trial-used-wall.tsx`** — **delete**. It is also the only place outside marketing
that hardcodes "$19 per month".

**`app/api/auth/signup/route.ts`** — remove `TRIAL_ALREADY_USED`, its message, and the whole
`phone_in_use` block with its fail-open handling. The duplicate-email branch returns 409
**`account_exists`** with sign-in wording; **keep both detection paths** (the
`user_already_exists` code and the empty-`identities` fallback) — Supabase resists enumeration
and returns the duplicate either way.

⚠️ **Do not touch the error-handling block below it.** Its comment records a measured fact:
supabase-js flattens a trigger failure to `AuthRetryableFetchError { status: 500, code:
undefined, message: "{}" }`, so SQLSTATE and DETAIL are gone before the error arrives. An earlier
revision matched `23505` there; it could never fire and was deleted. Do not re-add it.

Validation (names, email, phone, postcode `^\d{4}$`, password ≥8) is unchanged.

**`app/signin/sign-in-form.tsx`** — `"Create an account — 30 days free"`. One string.

## Out

`app/(marketing)/**` and `content/legal/**` are **parked** (ENG-1005) and ENG-977 owns `hero.tsx`
and the FAQ tabs — this slice must touch neither. Leave the `phone_in_use` RPC and
`idx_app_user_phone` in the database; this only stops *calling* the RPC, and ENG-742's backstop
still degrades a duplicate phone to null.

## Surface

```
app/start/page.tsx
app/start/trial-start-form.tsx
app/start/trial-used-wall.tsx                   (deleted)
app/api/auth/signup/route.ts
app/api/auth/signup/route.test.ts
app/signin/sign-in-form.tsx
```

## Design

`dev-handover/StablePass-mockups/mockups/web/screens/03-trial-start.html` plus
`_archive/03-trial-start.2026-08-15.html` — archived supersedes live, so check both.
⚠️ `.rx/mockups.md` path is stale — verified 5 Sep 2026. The **layout** is the reference; the
copy is not. No new CSS — every class needed already exists in `app/globals.css`.

## Acceptance

New signup lands on `/checkout` and sees no content anywhere · no trial wording in `/start`, the
form or `/signin` · `trial-used-wall.tsx` gone and unimported · `?trial=used` renders the normal
form · repeat email → 409 `account_exists`, both detection paths tested · repeat phone now
succeeds (deterrent removed by decision) · validation unchanged · `app/(marketing)/**` and
`content/legal/**` untouched in the diff.
