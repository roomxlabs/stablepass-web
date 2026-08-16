# stablepass-web — Gotchas (surfaces grill-me tends to under-specify)

## The BFF pattern is fixed — reuse it
Every gated read/write goes through a Route Handler in `app/api/*` using `supabaseServer()` from `lib/supabase/server.ts`. Don't call Supabase from client components for gated data. A new endpoint ticket's surface = `app/api/<x>/route.ts` + any `lib/` helper + a test.

## Envelope + status codes are a contract
Use `lib/api/envelope.ts` (`ok`/`created`/`noContent`/`fail`/`UNAUTH`/`GATED`). 401 = no session, **402 = lapsed subscription**, 404 = hidden content. Don't invent shapes.

## Next 15 route handler params are async
`{ params }: { params: Promise<{ id: string }> }` — you must `await params`. Same for `cookies()` (awaited in `supabaseServer`).

## Two Supabase clients
`supabaseServer()` (RLS as the user, cookies) for BFF routes; `supabaseBrowser()` (anon) only for non-sensitive client reads. Never the service role in this repo.

## Stripe is embedded (no redirect)
`/api/subscription/checkout` returns a **clientSecret**; the FE confirms with `@stripe/react-stripe-js`. There is **no** hosted-checkout redirect and **no** billing portal — cancel is `/api/subscription/cancel`.

## Design system comes from the mockups
Colours/fonts/spacing/components are translated from `docs/dev-handover/mockups/web/style.css` into tokens — don't hardcode ad-hoc values. Screen tickets cite `.rx/mockups.md`.

## Tests
Component/route tests are the pass/fail. A route ticket needs at least one test asserting the status-code + envelope behaviour (incl. the 401/402 branch).

## The base branch carries the tooling — check it, not `main`
`main` has no test runner, no `.rx/fe-harness.md` and no Playwright. All of it
(vitest, `@testing-library/*`, `playwright.config.ts`, `e2e/screenshots.spec.ts`)
lives on `feature/member-web-v1`. Inspect the ticket's declared base with
`git show origin/<base>:package.json` before concluding a manifest or runner is
missing — a worktree branched off the base has everything.

## Screenshot evidence = append a test to `e2e/screenshots.spec.ts`
Convention: seed fixtures with the local service-role admin client, create a
throwaway confirmed user, sign in through the real `/signin` form, screenshot to
`.rx/review/<ticket>-<state>.png`, and commit the PNGs (they're tracked). This
widening beyond a ticket's declared surface is expected for UI tickets, not scope
creep. Local Supabase must already be up — the harness never starts it.

## `new URL(x).href` normalises — don't write it back to an href
Validating a URL is fine; returning `url.href` rewrites what the admin entered
(a bare origin gains a trailing slash) and will fail an exact-match assertion.
Validate with `URL`, render the original trimmed string.

## `trainer.website_url` is unconstrained `text`
No CHECK constraint, no validation on the write path. A bare domain renders as a
RELATIVE href resolving to `/trainers/<id>/<domain>`. Any component putting a
stored URL in an `href` must require an absolute http(s) URL first.

## Analytics inserts: don't discard the Supabase `error`
Returning 204 unconditionally is right for fire-and-forget logging, but destructure
and log `error` anyway — RLS (`has_content_access`) and FK violations both produce
a silent 204-with-no-row that is otherwise invisible for months.

## No CSRF/origin check anywhere in this repo
There is no `middleware.ts` and no route does an origin check. Cookie-auth POSTs
with no custom headers are CORS-simple and forgeable cross-origin. RLS still pins
rows to the victim's own user_id, so impact is data pollution, not disclosure —
but assume it repo-wide rather than re-discovering it per ticket.

## Guardrail #8 cannot be checked by grep — it lives inside the JPEGs
The signed-off marketing mockup's inlined photographs are real racecourse shots, so
several carry incidental bookmaker branding: `739bbb9a.jpg` (Ladbrokes hoarding),
`4a5f34ce.jpg` + `daa70248.jpg` (Sportsbet on the LED board and rail). Those three are
**accepted** (DRI call, 16 Aug 2026): incidental venue signage in genuine racing
photography is not an endorsement, and ruling it out would rule out Australian racing
photography altogether.
What was NOT acceptable was odds rendered as our own product UI. The v2.6 app screen
`f70905af.jpg` had a third stat tile reading `$4.60 / STARTING`, contradicting the
page's own "Important note" and its "Is stablepass. a betting service? No" FAQ entry.
Re-cut as `57.5kg / WEIGHT` in v2.7 (`3334430f.jpg`), matching the sibling screen's
"Weight 57.5kg" for the same horse and race.
The lesson stands regardless: **a grep-over-source guardrail test is structurally blind
to image content**, so any ticket that commits imagery needs a human to eyeball the
assets. State the guardrail as "look at the pictures", not "grep the diff".

## Re-cutting an in-mockup app screen — edit the source, never the pixels
The app screenshots inside the marketing mockup are baked JPEGs, but they are authored
as live markup in `10-marketing-site/photo-pass-review/app-screens-source.html` (one
`.screen` per screen, a 320x692.5 canvas shot at deviceScaleFactor 2 → 640x1386).
Re-shooting an unmodified screen with Playwright reproduces the embedded bake
**pixel-identically** (mean per-channel diff 0.000), so edit that file, re-shoot the
one `#s<n>-<name>` element at JPEG q92, and re-inject by md5 — never patch pixels and
never hand-edit the 4.75 MB mockup whole. Verify the re-inject by re-inventorying every
data URI: exactly one md5 should leave and one arrive, the other 39 byte-identical, and
the extracted visible copy unchanged (client copy is locked).

## Marketing CSS must be scoped — `.btn`/`.btn-ghost` exist in BOTH stylesheets
`app/globals.css` loads on every route via the root layout, so a marketing page gets
it too, and both sheets define `.btn` (`padding:15px 30px` + `border:1.5px solid
transparent` vs `padding:12px 22px` + `border:none`) and `.btn-ghost`. Porting the
mockup's stylesheet verbatim makes the two collide on cascade order alone. Scope every
ported selector under a wrapper class (`.marketing`) — that also satisfies the
"tokens off `:root`" rule for free. The member palette is deliberately near-but-not-equal
(`--paper #FAF9F4` vs `--cream #FAF7F2`), so a leak shifts colour by a few hex points
rather than failing loudly.

## Don't set a pre-paint flag class on `<html>` from a nested layout
The classic `document.documentElement.className+=" js"` trick makes React report a
hydration mismatch on every load here, because `app/layout.tsx` renders `<html>` with
the next/font variable classes and a nested layout must not mutate it. Put the flag on
the route group's own wrapper instead (`currentScript.parentElement.classList.add("js")`
plus `suppressHydrationWarning`) and write the CSS as `.wrapper.js .rv`. Same gate, no
mismatch. Playwright catches this — assert the console has no hydration complaint.

## A script under `scripts/` cannot assume its depth above the repo
The loop runs in a worktree at `.claude/worktrees/<ticket>/`, which is two levels
deeper than a normal checkout, so a hard-coded `../../` to a sibling design tree
resolves to `stablepass-web/.claude/...` and the script dies. Search upward for the
target instead.
