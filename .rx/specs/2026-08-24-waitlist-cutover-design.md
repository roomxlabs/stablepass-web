# Waitlist cutover (W2–W6) — design spec

Epic: ENG-721. Tickets: ENG-726 (W2), ENG-729 (W3), ENG-730 (W4, HELD), ENG-732 (W5, HELD), ENG-734 (gate).
Grilled 24 Aug 2026. Base branch for all web slices: `feature/waitlist-v1` (seed by hand:
`git push origin origin/main:refs/heads/feature/waitlist-v1`). The gate merges to `main`; DNS moves via ENG-593 afterwards.

## Locked decisions (epic)
1. Inline email-only capture where the trial CTAs sit (hero + CTA band); nav "Join waitlist" scrolls to the hero form. No new route.
2. `/start` + `/signin` stay live on the app host, unlinked from marketing.
3. Pricing section CSS-hidden in waitlist mode; fine print keeps "$19 a month after your free trial".
4. Idempotent submits (duplicate email = same success); honeypot field `company`; no other rate limiting.
5. Progressive enhancement: the form works with JS blocked (Justin's browsing mode). Native POST answers 303 back to `/?joined=1`.
6. Copy: "Join the waitlist to enable your 30-day free trial" / header button "Join waitlist".

## W2 — /api/waitlist + WaitlistForm (ENG-726)
- `app/api/waitlist/route.ts` (new). **CORRECTED 24 Aug after ENG-723 landed — the three values below superseded what this spec originally said.** The authoritative contract is `stablepass-be docs/specs/api-contract.md` § Waitlist ("What the route must implement (ENG-726)"):
  - **Idiom: the `waitlist_join` RPC — `supabase.rpc("waitlist_join", { p_email })`.** SUPERSEDED TWICE; the history matters because each correction has a live trap in it.
    - Originally this spec said `.upsert(..., { onConflict: "email", ignoreDuplicates: true })`. ENG-723 measured that dead: a targeted `ON CONFLICT` arbiter needs SELECT visibility `anon` must never have on this table, so the upsert `42501`s on EVERY insert, not just duplicates; `onConflict: "email"` additionally `42P10`s because the unique index is an expression index on `lower(email)`, which PostgREST's column-list `on_conflict` cannot name at all.
    - ENG-723 therefore switched to a bare `.insert({ email })` with the route mapping `23505` to the success response. That worked, but it left dedupe observable one layer down: `anon` held INSERT on the table, so anyone with the publishable anon key could POST straight to PostgREST and tell `201` from `409`. The route's identical answer was a defence only for callers who used the form.
    - **CORRECTED 25 Aug by ENG-802 (W10).** The write now goes through `public.waitlist_join(p_email text) returns void` — `SECURITY DEFINER`, `search_path` pinned, `EXECUTE` granted to `anon`, added additively by ENG-770 (W9). Its body does an **untargeted** `ON CONFLICT DO NOTHING`, so a duplicate is swallowed server-side and PostgREST answers `204` for a fresh join and a repeat alike. **The `23505` mapping is deleted, not kept** — the code never reaches the route any more, so the branch was dead.
    - **The argument name is `p_email`, not `email`.** PostgREST matches the JSON body's keys to the function's parameter NAMES; a wrong key raises `PGRST202`, which falls through to the 500 branch rather than failing quietly.
    - Still never `.select()` — but for a NEW reason. The function returns `void`, so there is nothing to project (`?select=*` → `204`; a named column → `42703`). The familiar `42501` "RETURNING needs a SELECT policy" wall belongs to the **direct-table** path and does **not** transfer: a definer body is not gated by the caller's RLS at all.
    - **Never forward `error.details`.** Measured in ENG-770: the definer body runs as its owner (`postgres`, `BYPASSRLS`), so Postgres stops suppressing the failing-row DETAIL and a `23514` echoes the table's entire column list and order to an anonymous caller — where the direct-table path returned `"details": null`. The route's `error` binding is typed `{ code?: string }` so `details` is unreachable.
    - `23514` still reaches the route and still maps to the `400`: `ON CONFLICT DO NOTHING` swallows unique violations only, never a CHECK violation.
    - **Expand → migrate → contract.** ENG-770 added the function and deliberately left `anon` INSERT in place (nothing breaks); ENG-802 repoints this route (the migrate); **ENG-803 then revokes the `anon` INSERT grant and drops `waitlist_insert_anon`, which is what actually closes the enumeration channel.** Until ENG-803 lands the direct-PostgREST oracle is still open, and ENG-802 must land BEFORE it or the route breaks against a live BE.
  - **Success is `200 {data:{ok:true}}`**, not `201 {data:{joined:true}}`.
  - **Validation error code is `invalid_email`**, not `validation_failed`. The DB CHECK (`23514`) returns the byte-identical body, so neither becomes an enumeration oracle.
  - Cookie-free anon client (`createServerClient` with a no-op cookie adapter), NOT `supabaseServer()` — the route must run as `anon`, and must never write auth cookies on the marketing origin. Same shape as W4's trainer read. Envelope via `lib/api/envelope.ts`. Accepts JSON AND form-encoded. 500 `waitlist_failed`; 303 branches for native form posts. Normalise `email` (NFKC, strip zero-width, trim, lowercase) before insert.
- `middleware.ts`: add `/api/waitlist` to `isSharedPath()` (marketing host 404s all other `/api/*`; pinned test extended, not removed). Local dev does no host routing, so the middleware TEST is the proof, not localhost.
- `app/(marketing)/waitlist-form.tsx` (new, client component OUTSIDE sections/, the app-screens-carousel precedent): real `<form method="post" action="/api/waitlist">`, hidden honeypot, JS-enhanced inline states, reads `?joined=` after native round-trips.
- Surface adds: `test/waitlist-route.test.ts`, `test/waitlist-form.test.tsx`, `test/middleware.test.ts` (extend), `test/marketing-marquee.test.ts` (extend — its "no `fetch(`/no `<form>` under app/(marketing)/" guards were written for the v2.6 fake contact form and must sanction the real waitlist form by name).
- Honeypot renders as `hp_ref`, not `company`: `name="company"` beside a `Company` label is Chrome Autofill's COMPANY_NAME shape and Chrome ignores `autocomplete="off"` for address profiles, so an autofilled decoy would silently discard a real signup. The route honours BOTH names.
- Guardrails: no Supabase import under app/(marketing) (existing shell test); no service role anywhere.

## W3 — waitlist CTA mode (ENG-729, shared-surface: marketing.css)
- `layout.tsx`: `data-cta-mode="waitlist"` literal (launch switch-back = one line). Update the pinned attribute test.
- CSS: generalise the 2x2 pairing rule at `marketing.css:419` to per-mode rules; new `.cta-waitlist` class. Sanction additions via a pinned ALLOWED sub-describe in `test/marketing-shell.test.tsx` (the ENG-600 nav precedent, lines ~501-553). Zero deletions.
- Hero + CTA band: `.cta-waitlist` blocks with the locked copy + `<WaitlistForm/>`; existing trial/join blocks stay in the DOM. `hero-price` paragraph becomes trial-scoped.
- Nav: hide `.nav-signin` + `.nav-cta` in waitlist mode; add "Join waitlist" → `#top`. Nav + footer `#subscription` anchors hide.
- Pricing: `section#subscription` CSS-hidden, JSX untouched (fixture + switch-back).
- Copy-fidelity fixture (`test/fixtures/marketing-copy.json`) is FROZEN: layer allowed additions in the test, never regenerate, never remove a mockup run from the DOM.
- e2e rewrites: funnel spec asserts the waitlist funnel (no visible /start or /signin link anywhere); home spec's anchor check excludes hidden links; marketing spec's nav-CTA assertion becomes mode-aware. No-JS variants stay green.

## W4 — DYNAMIC trainer strip (ENG-730; decision change 24 Aug, supersedes the static export)
Trainers entered in admin flow to the site live. New server-only `lib/marketing/trainers.ts` (bare anon
client, no cookies) reads ONLY `public_trainer` (W7/ENG-765); marketing page fetches server-side with
`export const revalidate = 300` and passes the roster into the strip. `Trainer` type widens with `bio` +
`horses`; the 19 placeholder entries + both constants are deleted (`trainers.data.ts` stays as the type
home); photo = public `marketing-photos` bucket URL from `marketing_photo_path` (null = initials disc);
orphaned placeholder photos removed and asset pins re-pinned. Zero visible trainers = strip absent AND
its nav anchor hidden. Fetch failure = strip absent, error name logged server-side only.
Test-model surgery, all documented in-file: count/name pins become fixture-driven (vitest mocks the
fetch; e2e goes count-agnostic: >= 1 card, no placeholder strings, clone consistency at all widths,
no-JS variant kept); the trainer block leaves the frozen copy-fidelity comparison via a documented
subtraction; a NEW narrow guard asserts the only marketing-reachable Supabase usage is
`lib/marketing/trainers.ts` selecting `public_trainer` only. Playwright mocks the `public_trainer` REST
call in the existing interception harness.
Depends on W7 (view contract; on DEPLOY the view must exist or the strip renders empty, the designed
degrade). W8 (ENG-766, admin toggle) supplies live data; built against fixtures, live check at the gate.

## W5 — app screenshots re-cut (ENG-732, HELD: needs-spec)
Input: `10-marketing-site/real-screens/` staged by Naufal. 11 slots (hero phone, the-app phone + laptop, subscribers-get x8). md5-named assets, srcs repointed, hash-pinning tests re-targeted. The post-race slot keeps the no-odds guardrail assertion (v2.7 rule), re-pinned not deleted.

## W6 — gate (ENG-734)
Indexability flip (`MARKETING_IS_INDEXABLE = true` + its two pinned tests, same commit) once W4's real bios merge; full integration checklist; Justin approves images + bios on the preview; ONE PR `feature/waitlist-v1` → `main`; Naufal merges; then ENG-593 (DNS, Wix email export, MX survival) which this gate blocks. Deploy order: W1's migration pushed before the web deploy.

## Collision notes
`marketing.css` is owned by W3 alone (W2/W4/W5 must not touch it). `middleware.ts` owned by W2. `lib/seo.ts` owned by the gate. Fixture layering owned by W3 (W5 adds only the image-src layer).
