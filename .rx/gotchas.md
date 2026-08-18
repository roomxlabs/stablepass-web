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
No route does an origin check. Cookie-auth POSTs with no custom headers are
CORS-simple and forgeable cross-origin. RLS still pins rows to the victim's own
user_id, so impact is data pollution, not disclosure — but assume it repo-wide
rather than re-discovering it per ticket. There IS a `middleware.ts` as of
ENG-591, but it is host ROUTING only and deliberately not a security boundary:
do not reach for it as the place to add an origin check without deciding that
separately.

## `middleware.ts` builds but Next 16 has renamed the convention to `proxy.ts`
`npm run build` on Next 16.2 prints `The "middleware" file convention is
deprecated. Please use "proxy" instead.` and lists the entry as
`ƒ Proxy (Middleware)`. It is a warning, not an error — the file is picked up and
works. ENG-591 kept the `middleware.ts` name because the ticket, its surface and
its acceptance criteria all name that file. Renaming to `proxy.ts` is a real
follow-up, but it is a repo-wide convention change and wants its own ticket, not
a silent rename inside a feature slice.

## Two host env vars, inlined at BUILD time, with working defaults
`NEXT_PUBLIC_MARKETING_HOST` (default `stablepass.co`) and `NEXT_PUBLIC_APP_HOST`
(default `app.stablepass.co`), both in `lib/hosts.ts`. There is no `.env.example`
in this repo, so this is the only place they are written down. Two traps: they
are `NEXT_PUBLIC_*`, so a change needs a REBUILD, not just a redeploy of env; and
because the defaults are already correct for production, a deployment that never
sets them works — nobody discovers the knobs exist until a domain changes.
Setting the two to the SAME value would loop every member route on the apex;
`redirectHost` guards against that rather than trusting the dashboard.

## Middleware runs on the edge — keep it synchronous and I/O free
`middleware.ts` must not call Supabase or await anything: a network round-trip on
every request makes the whole app dynamic and defeats the caching the
marketing/member subdomain split exists to protect. It checks only whether an
auth cookie EXISTS. A stale cookie sending someone to `/explore` is fine — the
member layout's own server-side check is the real gate.

## Auth cookies are CHUNKED — match by prefix, never by exact name
`@supabase/ssr` splits a large session across `sb-stablepass-web-auth.0`, `.1`, …
so the bare name is often absent and an exact-name lookup silently fails for the
majority of signed-in members. Match "base name, or base name + `.`". Do NOT use
a loose `startsWith(AUTH_COOKIE_NAME)`: that also matches
`…-code-verifier`, the PKCE cookie present DURING sign-in before any session
exists, which would treat a mid-sign-in visitor as authenticated. Always import
`AUTH_COOKIE_NAME` from `lib/supabase/cookie-name.ts`; never retype the string.

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

## Adding a route can turn ANOTHER ticket's file red — `no-html-link-for-pages`
`@next/next/no-html-link-for-pages` only fires once the href resolves to a page
that **actually exists**. So a ticket that creates `/legal/[slug]` retroactively
makes every pre-existing `<a href="/legal/...">` elsewhere in the repo a lint
error — ENG-590 turned `app/start/trial-start-form.tsx:90-91` red without
touching it, and that file was on its do-not-touch list, making the ticket's
"lint green" criterion unsatisfiable as written.
Check before you claim a route ticket: `grep -rn 'href="/<your-route>' app/` and,
if the hits are outside your surface, negotiate the swap up front rather than
discovering it at the gate. Prove causation with a holdout — move your route dir
aside and re-run eslint; exit 0 means it is yours.

## A source-grep guardrail cannot see the layout chain — assert the build instead
"These routes stay static" greped over the route's own directory passes happily
while a `headers()` in `app/(marketing)/layout.tsx` (or the root layout) flips
them from `●` to `ƒ`. Measured: the whole suite stayed green through exactly that
regression. Assert the property against Next's own record instead —
`.next/prerender-manifest.json` must list each path with
`initialRevalidateSeconds: false`, and `dynamicRoutes["/x/[slug]"].fallback` must
be `false`. Guard it with `existsSync`: the documented gate is
`typecheck && lint && build && test`, so the manifest exists where it matters and
a bare `npm test` just skips that one assertion.

## Page metadata must set its own `alternates.canonical` — inheritance is silent
Next merges metadata layout→page per top-level key. A canonical set on
`app/(marketing)/layout.tsx` is inherited by every page under it, so a nested
route advertises the LAYOUT's URL as its canonical unless it sets its own. It
fails silently and only in the served HTML. Any page whose canonical must differ
from its layout's needs an explicit `alternates` in `generateMetadata` plus a test
on the emitted tag — asserting the metadata object alone does not prove what
shipped.

## `next start` on macOS poisons its own prerender cache via case-insensitive FS
One request to `/legal/PRIVACY` on APFS serves `privacy.html` off the file cache
(the lookup case-collides), then writes the computed 404 back to `PRIVACY.meta` —
the same inode as `privacy.meta`. The real page then 404s until the next build.
Does not reproduce on Linux/Vercel, where the two names are distinct files. If a
local prod server starts 404ing routes that demonstrably built, `rm -rf .next &&
npm run build` rather than hunting a routing bug.

## `it.skipIf` is safe where `describe.skipIf` is not
Vitest's `describe.skipIf` still runs the describe callback at collection time to
enumerate tests, so a `readFileSync(MAYBE_NULL!)` at describe scope throws and
takes the whole FILE down (that is #32). `it.skipIf(...)` never runs the test body
when skipped, so doing the risky read INSIDE the test body is the safe shape. Same
for `it.skipIf(cond).each(...)`.

## The mockup's hover affordances are `opacity:0` by design
`.t-over`, `.tr-over`, `.cta-fill` and `.cta-trial-line` sit at opacity 0 until
`:hover`/`:focus-visible`, and `marketing.css` ends with an `@media (hover:none)` block
that shows them outright on touch. A blanket "nothing is stuck at opacity 0" sweep will
flag all 25 of them on desktop Chromium. Exclude them by exact class name rather than
loosening the sweep, or it stops catching a genuinely failed reveal.

## W1's reveal script forces `suppressHydrationWarning` on every `.rv` element
The layout's inline script adds `.in` to `.rv` during parse, before React hydrates, so
each reveal element mismatches at hydration. W1 put `suppressHydrationWarning` on the
`.marketing` wrapper for the same reason, but the prop does not cascade — every `.rv`
element needs its own. Loudest under `prefers-reduced-motion`, where the script reveals
everything up front instead of waiting on the observer.

## React drops `open=""` on a plain element — it must be `open={true}`
The marketing CSS shows dialogs with `.sheet[open]` / `.tr-modal[open]`, so the
attribute has to land on a `<div>`. React knows `open` as a BOOLEAN attribute
(true of `<details>`/`<dialog>`) and applies that rule whatever the tag, so
`open=""` is falsy and React omits the attribute entirely — the dialog never
matches `[open]` and never becomes visible. Spread `{ open: true }`.

## A `setState` in an effect that sets the SAME value does not re-run dependent effects
Bit ENG-589 hard: a debounced resize handler cancelled the rAF then called a
rebuild that set `duplicated` to the value it already had. React bailed out of
the re-render, the effect keyed on `duplicated` never re-ran, and the cancelled
frame was never replaced — the marquee froze until reload. If an effect must
restart after a rebuild, key it on a generation counter the rebuild always
increments, not just on the values that *might* change.

## Playwright: `setViewportSize` BEFORE `goto` fires no resize event
So any `resize` handler is completely unexercised while the suite stays green.
To test a rebuild-on-resize, `goto` first, then `setViewportSize`. Also note
`locator.hover()`/`click()` wait for the element to be "stable" (an unchanged
box across two animation frames) — they time out forever against a continuously
animating element. Use `page.mouse.move()` to a coordinate instead, and remember
mouse coordinates are VIEWPORT-relative, so `scrollIntoViewIfNeeded()` first if
the target is far down the page.

## jsdom has no `matchMedia` and no layout
`test/setup.ts` polyfills `matchMedia` (default: everything false = hover-capable
desktop). For layout, `offsetWidth`/`clientWidth` are always 0, so any
width-dependent decision must be extracted as a pure function and unit-tested
with the widths written down — a rendered test cannot exercise it.

## Guardrail greps must collapse whitespace, or a line wrap defeats them
The `no fictional integration` check greps built output for the old contact
confirmation. A doc comment quoting it was wrapped across two lines by the
formatter and sailed past a contiguous search into the built sourcemaps. Sweep
`.map` files too (they carry comments and are servable), and normalise real
newlines, JSON-escaped `\n` and ` * ` comment gutters before matching — the same
trick `marketing-shell.test.tsx`'s betting check already uses.

## `lib/legal.ts` reads the filesystem — never import it into a client component
It does `readFileSync` at module scope, so importing it from a `"use client"`
file drags `node:fs` into the browser bundle. Server components (e.g. the
marketing footer) can use `legalPath()` freely.

## The marketing sections carry inert `data-*` triggers on purpose
`sections/faq.tsx` and `sections/for-trainers.tsx` ship `[data-sheet]` attributes
with no handler so a later slice can bind ONE `document` delegate and never
reopen those files. Don't "fix" them into local handlers — that is the mockup's
own architecture and it is what keeps the file surfaces disjoint.

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
## A NUL byte in a source file makes git treat it as BINARY — and the PR shows no diff
A sentinel written with a literal NUL escape (a `` that got emitted as the
raw byte rather than the escape text) put one NUL into
`app/(member)/expiry-banner.tsx`. Everything downstream stayed green — tsc,
eslint, vitest, `next build` and Playwright all passed, because a NUL is a
perfectly legal JS string character. The only symptom was `git show --stat`
reporting `Bin 0 -> 9165 bytes` instead of a line count, which would have
shipped the file to review as an unreadable binary blob with **no diff at all**.
`file` also reports `data` rather than `JavaScript source`, and
`grep -P '[\x00]'` does NOT reliably find it — use
`python3 -c "print(open(p,'rb').read().count(b'\x00'))"`.
Check `git show --stat` before pushing: any hand-written source file showing
`Bin` is this bug. Use an ordinary ASCII string for sentinels.

## `react-hooks/set-state-in-effect` is an ERROR here, not a warning
The lint config errors on `setState` called synchronously in a `useEffect` body,
so the usual "read `sessionStorage` in an effect and setState" hydration pattern
fails `npm run lint` outright. Use `useSyncExternalStore` with a
`getServerSnapshot` returning a sentinel — the server render and the hydration
render both produce the same output (no mismatch), and the real value swaps in
after hydration. `getSnapshot` must return a stable primitive or it render-loops.
setState in an event handler is still fine.

## Postgres hands timestamps back as `+00:00`, not `Z`
An e2e that seeds `trial_ends_at` with a JS `toISOString()` (`...275Z`) and then
asserts the value the browser stored will fail on an exact string compare — what
came back through PostgREST is `...275+00:00`. Compare instants
(`Date.parse(a) === Date.parse(b)`), not strings.

## Server-rendered `toLocaleDateString` uses the HOST timezone
`account/page.tsx` prints "Access to {date}" from `current_period_end` during a
SERVER render, so without an explicit `timeZone` the date is formatted in
whatever zone the container runs in: `2026-08-22T14:00:00Z` reads as 22 August
on a UTC host and 23 August to the Sydney member it is a promise to. This is an
AU-only product — pin `timeZone: "Australia/Sydney"` on any member-facing date.

## The day-count formula now exists in four places
`layout.tsx` (`trialLabel`), `account/page.tsx` (`trialDaysLeft`),
`checkout/page.tsx`, and `expiry-banner.tsx` (`daysUntil`) all compute
`Math.ceil(ms / 86_400_000)` independently. They agree today, and a divergence
would show as the sidebar chip and the banner disagreeing by a day. `daysUntil`
is exported from `expiry-banner.tsx` and `layout.tsx` already imports from that
module, so consolidating is cheap when a ticket next touches these files.

## `app/(member)/**` selects need their own column tests — e2e is not the guard
The gotcha above about un-widened `.select()`s applies to the `(member)` screens
too, but those are only exercised by Playwright specs that `test.skip()`
themselves when local Supabase is unreachable — i.e. they are silently absent in
CI, so a narrowed select there goes green everywhere. Pin the column list in a
vitest test (see `test/account-page.test.tsx`) and mutation-check it by
narrowing the select and confirming the test actually fails.

## Stripe object shapes move between API versions — never trust a mock alone
**(2026-08-16, ENG-581)** Checkout returned `clientSecret: null` on a **200**, so
Elements never mounted and nobody could pay — invisible for weeks because every
test mocked the *old* Stripe shape.
- **Symptom:** `/api/subscription/checkout` 200s, `clientSecret` is `null`, the
  Pay button renders disabled, no error anywhere.
- **Cause:** `stripe@22` pins `2026-06-24.dahlia`, where `Invoice.payment_intent`
  **no longer exists**. The first-purchase secret moved to
  `Invoice.confirmation_secret` (`{ type, client_secret }`). Stripe does **not**
  error on the stale expand — the field just reads back absent.
- **Do this:** expand + read `latest_invoice.confirmation_secret` first. Verify
  any Stripe shape against the **live sandbox** (raw REST or a node script), not
  against a mock or the SDK's `.d.ts`. `expand` **is** strictly validated (an
  unknown path 400s "This property cannot be expanded"), so a path that is
  accepted is a real property. `confirmation_secret` is a tagged union — accept
  only `type === "payment_intent"`; a $0 invoice yields a SetupIntent secret.
- **Note:** `lib/stripe.ts` calls `new Stripe(key)` with **no** `apiVersion`, so
  every request uses the SDK default, not the account's pinned version. Bumping
  the `stripe` package silently changes the wire shape for every route.

## Don't let a mocked unit test be the only gate on a Stripe/BFF contract
**(2026-08-16, ENG-581)** The suite was green against a checkout that could not
take a payment. When a route's shape comes from a third party, add a test that
mocks **only** the new shape (no legacy key at all) and confirm it **fails
against the pre-fix code** — otherwise the test is proving nothing.

## Two dev servers: `reuseExistingServer` will silently test the wrong worktree
**(2026-08-16, ENG-581)** `playwright.config.ts` hardcodes
`baseURL: localhost:3000` + `reuseExistingServer: true`. If another worktree is
already serving :3000, the e2e suite tests **that** code and reports green.
- **Do this:** when a sibling worktree is running, start your own server on a
  different port and run Playwright with a config overriding `baseURL`.
- **Gotcha:** use `localhost`, **not** `127.0.0.1` — Next dev blocks cross-origin
  dev resources from `127.0.0.1`, hydration never completes, and the sign-in form
  silently degrades to a native GET (it looks like an auth failure, it is not).

## The BFF cannot write `subscription` — and the dead write hid a duplicate-object bug
**(2026-08-16, ENG-582)** `/api/subscription/checkout` created a NEW Stripe Customer
**and** a NEW Subscription on every single page load — 5 loads produced 5 of each in
the live sandbox.
- **Symptom:** duplicate Customers/Subscriptions pile up; the route's existing
  `if (customerId) { reuse } else { create }` never takes the reuse branch.
- **Cause:** the reuse branch keys off `subscription.stripe_customer_id`, which this
  route can never persist. `public.subscription` has only `subscription_select_self`
  / `subscription_select_admin` — **both SELECT**. `sb.from("subscription").update(...)`
  therefore matches **zero rows, returns no error, and the result was unchecked.**
  A silent no-op that made the route *look* idempotent.
- **Do this:** never add a write path or an RLS policy for `subscription` — writes are
  service-role-only and the be `stripe-webhook` owns them. When a BFF route needs to
  remember something it cannot store, recover it from the third party instead.

## Stripe `customers.search` is eventually consistent — ~36s lag, measured
**(2026-08-16, ENG-582)** Do NOT use `customers.search` as a primary "does this
already exist?" lookup. Measured live at `2026-06-24.dahlia`: a Customer created at
t+0 did **not** appear in `customers.search({ query: "metadata['app_user_id']:'…'" })`
for **36 seconds**. The duplicates it was supposed to prevent were created 24-36s
apart — squarely inside that window, so a search-only fix still duplicates.
- **Strongly consistent alternatives (both verified at t+0):**
  `customers.list({ email })` and `subscriptions.list({ customer, status })`.
  Use those; keep `search` only as a fallback (e.g. no email on the auth record).
- **Never call `customers.list()` without a filter** — it returns other members'
  Customers, and picking one cross-wires billing. Guard on the email being present.
- `subscriptions.list` accepts `expand: ["data.latest_invoice.confirmation_secret"]`
  (and the legacy `data.latest_invoice.payment_intent`), so a REUSED subscription can
  hand back a current, payable `client_secret` rather than a remembered one.

## Deduping against Stripe: sort deterministically AND stably, `created` ties are real
**(2026-08-16, ENG-582)** Any member who hit the buggy route already owns several
Customers under one `app_user_id`, so lookups return N results in production, not one.
Take the newest by `created` **with the id as a tie-break** — `created` is only
second-granular, so ties are real: a probe run that seeded 5 customers back-to-back
produced tied timestamps (2 in one second, 3 in the next). (The 5 duplicates that
prompted the ticket happen to be 24-36s apart, i.e. untied — the tie-break is for the
back-to-back case, which is exactly what a double-click produces.) Without the
tie-break the pick can alternate between requests, which just relocates the
duplication. Assert stability in tests by resolving twice and comparing, not merely
that *a* result came back. Never auto-delete or merge the
duplicates — destroying payment records is not a route's job; stale `incomplete`
subscriptions expire on their own after ~23h.

## Stripe idempotency keys: digest the body INTO the key
**(2026-08-16, ENG-582)** A deterministic `idempotencyKey` on `customers.create`
collapses two genuinely concurrent requests (double-click, React StrictMode's double
effect) into one Customer — verified live. But Stripe **rejects a reused key whose
parameters differ** (`idempotency_error`, also verified), and a member's name/postcode
legitimately change between visits. Include a hash of the request body in the key so
each distinct body gets its own key; identical concurrent requests still collapse, and
a profile edit can never turn into a hard 502.

**Bucket the key in time (10 min), and key EVERY create in the flow.** Two follow-ons,
both found in review:
- Stripe replays a key for **24h**, which outlives what the key protects. A deleted
  Customer replays as a dead `cus_…` id (→ 502 until the key ages out), and an
  untouched `incomplete` Subscription expires at ~23h, so a 24h key has a window where
  the list correctly misses the expired sub, the create replays, and you hand back an
  **expired** `client_secret` — ENG-581's dead Pay button from a new direction. Add a
  short bucket: `Math.floor(Date.now() / 600_000)` in the key.
- **A strongly-consistent lookup does NOT close the concurrent case.** `list`-then-
  `create` is a TOCTOU: two overlapping requests both list before either creates, so
  both miss. Keying only `customers.create` collapsed the Customer while Subscriptions
  still stacked — the same bug, harder to see. Key every create in the flow, and prove
  it with a `Promise.all([POST(), POST()])` test; every sequential
  `await POST(); await POST();` test passes while the concurrent bug is live.

## Adopting a third-party object? Re-assert EVERY property the create path guarantees
**(2026-08-16, ENG-582)** When `/checkout` started reusing an existing `incomplete`
Stripe Subscription, the filter checked only the price. That silently accepts a
subscription made by the Stripe dashboard, a support action, or a future flow:
- missing `metadata.app_user_id` → the member pays and the be `stripe-webhook` cannot
  resolve the subscriber: **charged but never activated**, with no error anywhere;
- `cancel_at_period_end: false` → we hand out an **auto-renewing** pass, breaking the
  one rule the product is built on.
Reuse filters must re-assert every invariant the create call sets — price **and**
metadata **and** the pre-armed cancel. Same rule for the Customer lookup (match on
`metadata.app_user_id`, and re-check it locally rather than trusting the search query
string to have scoped the result).

## The sign-in mockup still carries copy we deliberately changed
`mockups/web/screens/02-signin.html:50` still reads *"Not subscribed yet? Start
30 days free"*. ENG-583 replaced that in `app/signin/sign-in-form.tsx` because it
never said it CREATES AN ACCOUNT and produced duplicate accounts (it sits right
under "Forgot your password?"). The live copy is *"Don't have an account? Create
an account — 30 days free"*. **Rebuilding /signin from the mockup would regress
it** — the mockup is the design source for layout/type, not for this string.

## `overflow`/`text-overflow` do nothing on an inline element
Truncating text with `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`
silently no-ops on a `<span>`: those properties need a block-level box, so the
text overflows and is hard-clipped by an ancestor with no ellipsis. Any new
truncating rule must also set `display: block` (or inline-block/flex). This bit
`.sidebar-user .meta .email` (ENG-583) while its sibling `strong` worked purely
because it already set `display: block`. A unitless `line-height` means the swap
costs no height, so nothing below it moves.

## Playwright silently reuses whatever is on :3000 — check whose server that is
`playwright.config.ts` sets `reuseExistingServer: true` with `baseURL
http://localhost:3000`. If a colleague already has `npm run dev` there (and
theirs may point at the **Sydney** project, not local Supabase), the whole e2e
run exercises *their* branch against *live* data and the results are meaningless
— it does not fail, it just lies. Before trusting an e2e run, confirm who owns
:3000 (`ss -ltnp | grep :3000`). To run in isolation, copy the config, set
`baseURL` to another port and `command: "npm run dev -- --port 3100"` with
`reuseExistingServer: false`, and keep it out of the commit.

## `subscription.trial_ends_at` is NOT NULL
Any fixture that seeds an `active` member must still supply a `trial_ends_at`
(the past date their trial ran to before they converted). Passing `null` fails
with `23502 null value in column "trial_ends_at" violates not-null constraint`.
`current_period_end` IS nullable — and on an `active` row a null there means
ENTITLED (paid, webhook in flight), never expired.

## "not entitled" does NOT mean "the date has passed"
`hasAccess()` denies `canceled`/`lapsed` on the STATUS alone without reading the
date, and those rows legitimately keep a FUTURE `current_period_end`
(`docs/specs/database.sql`: "canceled keeps access until this"). Any copy that
narrates the date in the past tense must test the clock, not `!entitled`, or it
prints "Ended <date>" days before that date arrives.

## The lint rule forbids `Date.now()` during render
`Error: Cannot call impure function during render` — put clock reads in a
module-scope helper with an injectable `now` (see `hasAccess`, `trialDaysLeft`,
`formatEndDate`, `hasPassed`), never inline in a component body.

## `lib/api/access.ts` must stay client-safe
It is imported by `"use client"` components (the expiry banner and four content
gates), so it may hold only pure predicates. Anything needing `supabaseServer`
goes in `lib/api/subscription-state.ts` instead. Corollary: resolve
`stripe_customer_id` server-side and pass the derived boolean — never the row —
across a client boundary.

## CLAUDE.md's "never commit" — RESOLVED, the file now says it explicitly
Both epics hit this independently. The Conventions section used to say only "stop
at `git add`", while the implement loop's whole contract is commit → push → PR.
Every ticket in the stripe-trial epic landed by treating the line as
interactive-only; in the marketing epic two Opus workers read the same line in
OPPOSITE ways in one session, one committing and one refusing and escalating.
It is no longer ambiguous: `CLAUDE.md` now scopes the rule to interactive
sessions and carves the loop out in writing — own ticket branch only, never
`main`, never a shared branch, only its declared surface. Follow the file, not
this note.

## A grep guard that matches on ADJACENCY is defeated by hoisting the value
**(2026-08-18, ENG-617)** The guard forbidding the deleted age formula matched
`/getFullYear\(\)\s*-/` and `/[-+*]\s*foaling_?[Yy]ear/`. Both miss the refactor
anyone would actually reach for:
```ts
const thisYear = new Date().getFullYear();
const age = thisYear - row.foaling_year;     // guard silent
```
The date call moved to another line, and `row.` sits between the operator and
the name. That exact idiom was already in this repo (`e2e/screenshots.spec.ts`).
Match on the **identifier** with `[\w.]*` stepping over the property access
(`/[-+*/]\s*[\w.]*foaling_?[Yy]ear/`), cover `getUTCFullYear`, and **self-test
the guard**: assert its patterns fire on a list of known reintroduction shapes
and stay quiet on the legitimate ones. A guard nobody tested is a guard that
silently rots. Scan `e2e` too — `test` cannot be scanned, since the guard file's
own regex literals match themselves.

## "Assert a positive first" means PRESENCE — another absence is not a positive
**(2026-08-18, ENG-617)** Countering the documented vacuity trap with
`expect(container.querySelector(".profile-header-web")).toBeNull()` fixes
nothing: it is a second negative, so a screen that regressed to rendering
*nothing at all* still passes every assertion. `AccessWall` ships
`data-testid="access-wall"` (`components/access-wall.tsx:85,96`) — assert
`screen.getByTestId("access-wall")` and let it throw. Same rule for routes: pin
`res.status` **and** one real field.

## A fake clock straddling a calendar boundary needs ≥1 DAY, not an hour
**(2026-08-18, ENG-617)** A "the value must not move across the New Year" lock
set to `2026-12-31T23:59+11:00` → `2027-01-01T00:01+11:00` passed against a
deliberately broken implementation. `getFullYear()` reads the **host** zone, and
this machine is `Australia/Brisbane` (UTC+10), where both instants are still
31 December. Use instants two days apart (`2026-12-30T12:00Z` →
`2027-01-02T12:00Z`): they land in different calendar years at every offset from
−12 to +14. Also prefer `vi.useFakeTimers({ toFake: ["Date"] })` — faking timers
wholesale stalls the awaits inside a route handler.

## The horse reads DISCARD the Supabase `error` — a missing column 404s silently
**(2026-08-18, ENG-617)** `app/api/horses/[id]/route.ts` and
`app/(member)/horses/[id]/page.tsx` both did `const { data } = await sb.from(...)`
and dropped `error`. A query error lands in the same branch as a hidden row, so
an undeployed computed column (`42703`) makes **every** horse profile 404 with
nothing logged, indistinguishable from enumeration-resistance working correctly.
Both now `console.error` it. When a projection names a column that a pending
migration adds, log the error or the deploy-order failure is invisible — and
never "fix" the 42703 by trimming the projection.

## `.rx/mockups.md` is STILL wrong — the living mockups are in `06-stage1-design`
**(2026-08-18, ENG-617)** The manifest (and the entry above it, from ENG-571)
names `<workspace>/dev-handover/StablePass-mockups/mockups/web/`. That directory
does not exist anywhere in the workspace. The real, living source is
`<workspace>/06-stage1-design/mockups/web/screens/` (e.g.
`07-horse-profile.html`), which is what the ENG-617 ticket itself cited. `ls` the
design path before building, and do not trust either the manifest or `CLAUDE.md`
§ Design source.
