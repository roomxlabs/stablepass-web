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
`/api/subscription/checkout` returns a **clientSecret**; the FE confirms with `@stripe/react-stripe-js`. There is **no** hosted-checkout redirect and **no** billing portal.

## The pass does NOT auto-renew — there is no cancel route
`/api/subscription/cancel` and `/api/subscription/payment-method` were **deleted** (ENG-567).
The 30-day pass never renews: the Stripe Subscription is created with
`cancel_at_period_end: true` at creation, so there is nothing to cancel and no
future charge to re-card for. An `active` member hitting `/api/subscription/checkout`
is an **early renewal** (a one-off PaymentIntent), not a `409 already_active` —
`/checkout` therefore no longer redirects active members away. `docs/specs/*`
still describes the old cancel/payment-method endpoints; those docs are stale.

## `.rx/mockups.md` points at a DEAD path — the real mockups are outside the repo
The manifest says `../docs/dev-handover/mockups/web/`. That directory does not exist.
The real HTML mockups live at `<workspace>/dev-handover/StablePass-mockups/mockups/web/screens/`
(e.g. `04-checkout.html`). `ls` the path before building a screen; don't trust the
manifest until the fix lands. Same for the `docs/dev-handover/mockups/web/*` claim in
`CLAUDE.md` § Design source.

## Screenshotting a screen whose data needs an unconfigured third party
With no `STRIPE_*` keys the checkout BFF 502s before it can resolve a price or a mode,
so the populated/renewal states are simply unreachable end-to-end. Use Playwright's
`page.route()` to fulfil the BFF call with the route's **exact** response shape, and keep
one unstubbed test for the genuine failure path. Say so in the PR — a stubbed screenshot
proves the SCREEN, not the route→screen contract.

## `undefined` values vanish from a JSON response — pin the key SET in tests
`ok({ publishableKey: process.env.NEXT_PUBLIC_... })` with the env var unset serialises to
a body with **no such key**. Per-field assertions on a mocked env miss this, and renaming a
response field kept the whole suite green while making checkout permanently unpayable.
Assert `Object.keys(body.data).sort()` for each branch of any route the FE destructures.

## Stripe `customers.update` REPLACES the whole `address` hash
Sending `address: { country: "AU" }` to update a customer nulls any `postal_code`/`line1`/
`city` Stripe already holds. Only send `address` when you actually have the sub-fields;
on `customers.create` there is nothing to overwrite, so a country-only address is fine.

## The checkout route is only safe against the ENG-568 webhook — release order matters
`/api/subscription/checkout` writes the contract the **new** be `stripe-webhook` expects.
Against the **old** webhook (be `main`) it breaks two ways, both silent:
1. `cancel_at_period_end: true` is set at CREATION, and the old webhook treats any
   `customer.subscription.updated` carrying that flag as `status = "canceled"` — so a
   member pays and is immediately 402'd out of the content gate.
2. Early renewal stamps `metadata.new_period_end`, but the old webhook reads
   `metadata.current_period_end` → `Number(undefined)` → NaN → the period is never
   extended. The member is charged and gets zero days.
**ENG-568 must merge and DEPLOY before this route is live.** On the shared
`feature/stripe-trial-v1` integration branch this is the gate ticket's job to sequence.

## Never hardcode the price — derive it from the Stripe price
The sandbox price is **A$1.00** and production is **A$19.00**. `/api/subscription/checkout`
retrieves `STRIPE_PRICE_ID` and returns `unitAmount`/`currency`; the FE formats every
amount from those. A hardcoded `1900`/`"AU$19.00"`/`1.73` makes the screen claim one
number while Stripe charges another. GST is display-only: `unitAmount / 11` (AU prices
are GST-inclusive). `Intl.NumberFormat("en-US", { currency: "AUD" })` renders the
unambiguous `A$19.00`; an `en-AU` locale would render a bare `$19.00`.

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

## `sb` is untyped — `tsc` can NEVER catch a too-narrow `.select()`
`lib/supabase/server.ts` calls `createServerClient` with no `Database` generic, so
every `data` is `any`. A route that selects fewer columns than the consuming helper
reads compiles clean and fails at RUNTIME, silently: the missing field is
`undefined`, `Date.parse(undefined)` is `NaN`, and a gate built on it fails CLOSED —
locking out real paying members with no type error and no crash. Any route test for
a gated route must therefore assert the SELECTED COLUMNS
(`expect(subSelectMock).toHaveBeenCalledWith(...)`), not just the status code. Where
a column list is shared across call sites, export it as a constant next to the rule
it feeds (see `ACCESS_COLUMNS` in `lib/api/access.ts`) so the bug class is
structurally impossible rather than tested for N times.

## The BFF is NOT the only gate — `app/(member)/**` reads Supabase directly
Several server/client components bypass the Route Handlers entirely and query
Supabase themselves, each with its own inline copy of the entitlement rule:
`horses/[id]/page.tsx`, `trainers/[id]/page.tsx`, `horses-grid.tsx`,
`trainers-grid.tsx`, `saved/saved-feed.tsx`, `following/following-screen.tsx`,
`app/onboarding/page.tsx`. So "I hardened `app/api/`" does NOT mean the screen is
gated. Any ticket that tightens access must state whether the `(member)` layer is in
or out of scope, and an epic must not be closed on the `app/api/` half alone.

## All-negative test assertions pass vacuously on a 402
A test whose assertions are only `not.toContain` / `not.toMatch` (typical of the PII
guardrail tests) still passes if the route returned a `402 subscription_required`
envelope — it asserts nothing at all. Always pin `expect(res.status).toBe(200)` plus
one POSITIVE field before the negatives. This bit the `trainer_contact` guardrail;
it was only caught by flipping the fixture to `lapsed` and seeing the test stay green.

## Route-test coverage is patchier than the ticket surface implies
`test/{feed,horses,trainers}-route.test.ts` are named per AREA but each imported only
ONE route. `feed/following`, `horses/[id]/feed` and `trainers/[id]/feed` had zero
route-level tests. Before trusting "extend the existing tests", run
`grep -rn 'from "@/app/api' test/` to see what is actually covered — and add the new
`describe` blocks to the existing area file rather than a new file, to stay in surface.

## Asserting `.select()` args needs a PERSISTENT chain for that table
`horses`/`trainers` route tests build a fresh chain per `from()` call
(`makeChain(table)`), so the `select` spy is a NEW mock each call and
`toHaveBeenCalledWith` never sees it. Create the `"subscription"` chain ONCE in
`vi.hoisted()` and return it for that table, exposing its `select`; `mockClear` it per
test. Minimal, additive, leaves the other tables' per-call behaviour intact.

## `.rx/mockups.md` pointed at a directory that never existed (fixed in ENG-571)
The manifest named `../docs/dev-handover/mockups/web/`; `ls` fails on it. The real root
is a SIBLING of this repo: `<workspace>/dev-handover/StablePass-mockups/mockups/web/`.
`dev-handover/` is not a git repo, so nothing under it is versioned — superseded screens
are archived by hand under `screens/_archive/`. `ls` the design path before building, and
note that `CLAUDE.md`'s "Design source" line still repeats the old dead path.

## `getByRole("alert")` is ambiguous in Playwright — Next's route announcer is one too
`#__next-route-announcer__` is `role=alert`, so `page.getByRole("alert")` is a strict-mode
violation on any App Router page that also renders a `.form-error`. Target the class
(`page.locator(".form-error")`) in e2e specs. jsdom/RTL is unaffected — only Playwright.

## `maxLength` really is enforced against Playwright's `fill()`
`fill()` does NOT bypass `maxLength`, so a field with `maxLength={4}` can never receive a
5-char or space-padded value from an e2e test — `'  0800  '` silently arrives as `'  08'`
and the test fails on a validation error that looks inexplicable. Pin over-long/untrimmed
input in ROUTE tests (where a non-browser client can really send it); in component tests
use `fireEvent.change`, which does bypass it.

## A real signup + a cold `/onboarding` outruns Playwright's 30s default
Playwright's per-test timeout is 30s, so a `waitForURL` with a longer timeout still dies at
30s. An e2e test that signs up for real and waits on a first-hit `next dev` route compile
needs an explicit `test.setTimeout(120_000)`, not just a bigger `waitForURL` timeout.
