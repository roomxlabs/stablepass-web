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

## `npm run build` does NOT typecheck `e2e/`
Next excludes `e2e/` from its build, so a Playwright spec can be type-broken while
`npm run build` stays green. `npm run typecheck` (tsc --noEmit) is the only gate that
sees it. Run typecheck AFTER adding e2e specs, not just after the app code.
Symptom seen: 22 × TS2345 from helpers typed `ReturnType<typeof createClient>` — use
`SupabaseClient` from `@supabase/supabase-js` for a client passed as a parameter.

## Dates: `race.race_date` is the AU racing day — never derive "today" from the host
Server-side date/clock helpers must pin `Australia/Sydney` (see `RACING_TZ` in
`lib/races.ts`). Deriving the day from `Date#getDate()` works on an AU laptop and breaks
on a UTC host: the "Racing today" band goes blank for the first ~10h of every race day and
race times render up to 10h off. Route handlers and server components both run server-side,
so "the viewer's locale" is never available there.
Corollary for tests: do NOT re-implement the route's date helper in the test — that makes
the assertion tautological (both sides drift together). Pin a literal instant + expected day.

## `fetchHorseRaces` has a visibility precondition
`race_horse`'s RLS is subscription-scoped (`has_content_access`), NOT horse-scoped. Reading
runners for a hidden/disabled horse returns rows. Callers must confirm the horse is visible
(the `horse` read + 404) BEFORE calling. The race-day route relies on the `horse:horse_id`
embed returning null for hidden horses and drops those rows explicitly.

## TS2589 when passing the Supabase client to a helper
Typing a helper param structurally against `SupabaseClient` makes tsc bail with
"type instantiation is excessively deep" (PostgREST's recursive builder generics). Type the
param as `{ from: (t: string) => unknown }` and narrow inside the helper instead.
