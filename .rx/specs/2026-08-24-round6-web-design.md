# Round 6 polish, web slices (R20–R22) — design spec

Epic: ENG-737. Tickets: ENG-761 (R20), ENG-762 (R21), ENG-763 (R22). Gate: ENG-764.
Grilled 24 Aug 2026. Base branch: `feature/round6-v1` (distinct from the waitlist epic's
`feature/waitlist-v1`; the two web epics run on separate branches and disjoint surfaces).
Serialization: R20 → R21 (both own components/post-card.tsx).

## R20 — member card parity (ENG-761, blocked by R1; supersedes parked ENG-425)
- Label pill: `components/post-card.tsx` renders post.label as the green top-of-card pill on all web cards
  (web has no reel variant this round). Type the field on FeedPost; assert the column at the data layer
  (house gotcha: (member) selects need their own column tests).
- Clamp: `.post-body-web` gets a 2-line clamp + "more" opening the detail.
- Photo chip: photo posts mirror the video duration chip.
- Follow pill: `following-screen.tsx` renders no pill (canFollowTrainer false there); `explore-feed.tsx`
  unchanged; the two copies stay per-screen by design.
- Stat labels: `.stat-label` nowrap so PRIZEMONEY never wraps at narrow widths (globals.css:941-966).
- Name formatter: new `lib/format/horse-name.ts` (port of mobile format.ts INCLUDING the AUS strip:
  title-case, keep non-AUS registrar codes, drop "(AUS)"), applied at member name render sites. Fixes the
  existing raw-ALL-CAPS divergence from mobile.
- e2e note: the local feed edge fn is a stub (gotcha): explore/following are covered by component tests +
  mocked routes, not end-to-end.

## R21 — multi-photo carousel (ENG-762, blocked by R2 + R20)
- BFF read paths extend to `post_media` (one ordered batched select, signed server-side alongside existing
  media signing); FeedPost gains `media: {url, sort}[]` (empty for legacy).
- `components/photo-carousel.tsx`: CSS scroll-snap (no library), dots + n/m chip, dots are buttons; card +
  detail mount it. Single photo unchanged.

## R22 — repeat-signup wall (ENG-763, blocked by R3)
- `app/api/auth/signup/route.ts`: before auth.signUp, normalise the phone (TS mirror of normalize_phone in
  new `lib/format/phone.ts`, fixtures shared with R3's SQL matrix) and call R3's `phone_in_use` RPC.
  Match (or the existing email_taken 409) → `409 {error:{code:"trial_already_used"}}`, no account created.
  RPC unavailable → fall back to attempting signup (DB backstop still degrades the phone; log the fallback).
- `trial-start-form.tsx` wall: "Looks like you've already had your free trial" + join-for-$19 prompt,
  CTA "Sign in to join" → /signin. One generic message; never reveal which credential matched.

## Guardrails
No owner fields, no comment affordances, no betting copy; signed URLs minted server-side only; card data
never touches our API; marketing route group untouched by all three slices.
