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
`.rx/review/<ticket>-<state>.png`. Do NOT commit the PNGs: `.rx/review/` is
gitignored, and evidence ships on a `screenshots/<ticket>` branch instead (full
convention below, under "`.rx/review/` is gitignored, but three PNGs in it are
still TRACKED"). This widening beyond a ticket's declared surface is expected for
UI tickets, not scope creep. Local Supabase must already be up — the harness never
starts it.

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

## Design-source CSS guards must strip comments before scanning (ENG-613)

**Symptom:** a green `post-media-ground` guard went red on a diff that added no
brand green anywhere, reporting `.post-badge` as an offender.

**Cause:** the guard scans `GLOBALS.match(/\.post-media-web[^{]*\{[^}]*\}/g)`.
`[^{]*` happily crosses newlines, so a `.post-media-web` mentioned inside a
COMMENT swallows everything up to the next `{` and attributes the FOLLOWING
rule's declarations to the media box. Merely explaining a selector in prose
could fail the guard — or, worse, mask a real one.

**Do this:** strip comments (`css.replace(/\/\*[\s\S]*?\*\//g, "")`) before any
regex that treats CSS text as structure. Applied to `post-media-ground.test.ts`
and to the new `post-card-parity.test.ts`.

## The local `feed` edge function is a STUB — /explore and /following cannot be e2e'd (ENG-613)

**Symptom:** a Playwright test that seeds published posts and visits `/explore`
sees the "Nothing here yet" empty state, so any assertion about a card there
passes vacuously.

**Cause:** both `/api/feed` and `/api/feed/following` go through
`edgeFetch(sb, "feed?…")`, and the local Supabase edge runtime serves the
admin-branch scaffold `feed` stub, which returns `{ data: [], meta }` regardless
of content. The real fn ships in stablepass-be.

**Do this:** evidence feed-screen components on the two PROFILE feeds
(`/api/{horses,trainers}/:id/feed` are direct reads and do render locally) and
on the no-auth gallery at `/preview/components`. Keep that gallery current when
the shared card changes — it was still previewing the pre-round-5 card.

## Screen-level follow state already exists — do not add a read (ENG-613)

`explore-feed` and `following-screen` each ALREADY read the viewer's follows for
their aside/rail. Derive the Follow pill from those rather than adding a query,
and model the state as `Set<string> | null` where `null` is "not known yet" —
conflating it with "follows nobody" flashes a pill on every card and retracts it.

## Two buttons named "More" on one card — the caption affordance collides with `⋯` (ENG-761)

The post card's options control is `<button aria-label="More">` (`.post-more-web`).
Round 6 added a caption "more" affordance to the same card, so a Playwright
`getByRole("button", { name: "more" })` matched **one per card plus the real one**
(five where one was meant) — Playwright's `name` is case-insensitive and
substring-trimmed unless you pass `exact: true`.

- **Symptom:** a locator that looks unambiguous resolves to N+1 elements; the count
  scales with how many cards are on the page, which reads like a render bug.
- **Cause:** two controls with the same accessible name in one card. That is also a
  real a11y defect, not only a test problem — name navigation cannot tell them apart.
- **Do this:** the caption button carries `aria-label="Expand caption"` while still
  *showing* the word "more". Locate it by `.post-caption-more`, not by name.

## A line-clamp must go on the TEXT, never on the box that holds the affordance (ENG-761)

The obvious reading of "`.post-body-web` gets `-webkit-line-clamp: 2`" is wrong once
there is a "more" button: the button is a child of `.post-body-web`, so the clamp
counts it as part of the clamped flow and hides the very control that undoes the clamp.
- **Do this:** clamp an inner `.post-caption`; keep the button its sibling.
- **Measuring "does it overflow":** compare `scrollHeight - clientHeight > 1` after
  layout, with a 1px tolerance — sub-pixel line heights make an exactly-two-line
  caption measure a hair over, which shows a "more" that reveals nothing. A character
  count is always wrong at some viewport.

## The web member app has NO post-detail route (ENG-761)

`app/(member)` is explore, following, saved, horses, horses/[id], trainers,
trainers/[id], account, checkout. There is no `posts/[id]` page — only
`app/api/posts/[id]/playback`. Any ticket whose copy says "opens the post detail"
(ported from mobile, which does have one) has no route to open on web. ENG-761's
caption "more" expands in place instead. Check before promising navigation.

## The profile feed routes have EXPLICIT post column lists — a new `post` column stops there

`/api/feed` and `/api/feed/following` proxy the be `feed` edge fn (`returns setof
post`), so a new post column reaches those two screens for free. The **profile** feeds
do not: `app/api/horses/[id]/feed/route.ts` and `app/api/trainers/[id]/feed/route.ts`
name their columns one by one, and `saved-feed.tsx` uses `post:post_id(*)`.
- **Consequence on ENG-761:** `post.label` reaches Explore and Following but NOT the
  horse/trainer profile feeds, whose selects were on the ticket's do-not-touch list.
- **Do this:** when a ticket adds a `post` column that the card renders, list all four
  read paths and say explicitly which ones are in scope. "The feed carries it
  automatically" is true of exactly two of them.

## `follow_no_duplicate` does NOT stop a second trainer follow (preserved from ENG-613)

Recorded here because ENG-761 deleted the code this lesson lived in (the
Following screen's `follow()` write path went with the Follow pill), and the
constraint detail existed nowhere else.

`follow_no_duplicate` is `unique (user_id, trainer_id, horse_id)`, and a TRAINER
follow has `horse_id IS NULL`. **Postgres treats NULLs as distinct**, so that
unique constraint does not prevent a second row. A fast double-click before the
optimistic re-render writes two, and the Following rail then lists the trainer
twice — a duplicate React key.
- **Do this:** any new trainer-follow write needs its own in-flight guard (an
  `useRef<Set<string>>` keyed by trainer id), not a reliance on the constraint.
- Explore's `explore-feed.tsx` still has this pattern intact; copy it from there.

## Five surfaces re-declare `PostRow` + their own `FeedPost` mapper — a new `post` column needs FIVE edits
Adding a column to `post` and rendering it in `components/post-card.tsx` is **not** enough
for it to appear. Five member surfaces each carry their **own** local `PostRow` type and
their **own** row→`FeedPost` mapper, and a column missing from either is dropped silently:
`app/(member)/explore/explore-feed.tsx`, `following/following-screen.tsx`,
`horses/[id]/horse-posts.tsx`, `trainers/[id]/trainer-posts.tsx`, `saved/saved-feed.tsx`.
ENG-761 added `post.label` + the card render and shipped the pill broken on three of the
five; ENG-772 fixed the two profile feeds, ENG-775 covers `/saved`. So a ticket that says
"the card already renders it, this is purely the read path" is under-scoped by default —
budget one edit per mapper, PLUS one per explicit projection. Symptom is invisible to
`tsc` (every mapper input is `any`) and invisible to a route test (the route returns the
column correctly; the screen throws it away one layer later). Do this: for any new `post`
column, grep `FeedPost\[\]` and edit every hit, and cover it with a RENDER test through the
real mapper, not only a projection assertion.

## An explicit PostgREST projection is load-bearing in BOTH directions, and BOTH fail SILENTLY
`select("a, b, c")` **rejects the whole query with `42703` / HTTP 400** if any named column
is not deployed — unlike `select("*")`, which just omits it. So a projection breaks two
ways: too narrow silently starves the UI (see above); too wide kills the entire result set
against any project without the migration. **Neither shows up as a 500.** Measured, not
assumed: `curl .../rest/v1/post?select=id,nonexistent_col` → `400 {"code":"42703"}`, and
supabase-js turns that into `{ data: null, error }`. Our routes destructure **only** `data`
(`const { data: posts } = await sb…`; no route in `app/api/{horses,trainers}/[id]/feed`
inspects `error`), so `ok(posts ?? [])` returns a cheerful **200 `{"data":[]}`** and the
screen renders its empty state. The screens' own `setError(true)` path is unreachable for
this entire error class. Net effect of naming a column too early: a **silent total content
blackout** that is indistinguishable from an empty stable. Treat "web names a new column"
as a **deploy-order dependency on that column's migration**, not a cosmetic risk.
`sb` is untyped, so `tsc` catches neither. Assert the
**exact** projection string (`.toBe(...)`, not `.toContain(...)`) in the route's test —
that is the only assertion that pins both directions — and before naming a new column,
verify it is actually deployed on the base you are targeting, e.g.
`docker exec supabase_db_stablepass psql -U postgres -d postgres -c "\d public.post"`.

## The profile feeds CAN be e2e'd end to end; `/explore` and `/following` cannot
The local `feed` edge function is a stub, so Explore/Following can only be component-tested
with mocked routes. But `app/api/{horses,trainers}/[id]/feed` read `post` **directly** from
local Postgres, so they drive the full stack for real — seed a trainer/horse/post with the
admin API, sign in through `/signin`, assert on the live page (see
`e2e/eng-772-profile-label-pill.spec.ts`). Prefer these two for real end-to-end evidence of
anything card-related. Corollary, and the reason ENG-761's bug shipped: a screenshot of
`/preview/components#round6` proves nothing about the read path — the gallery builds its
`PostCard` props by hand and bypasses both the projection and the mapper.

## `post_media` reads go in their OWN query, never in the `post` projection
**(2026-08-24, ENG-762)** The table is only on be `feature/round6-v1`, not `main`.
Per the 42703 rule above, naming its columns on the `post` select would blank the
**entire feed** silently anywhere the migration is not deployed. Isolated in
`lib/post-media.ts`, the same failure costs only the carousel: `readPostPhotos`
returns an empty map and every card falls back to `post.media_url`.
- The be contract requires it anyway: one batched `.in('post_id', …)` ordered
  read per page, then sign. Never per post.
- The ordering column is **`sort_order`** (not `sort`), 0-based, `CHECK 0..9`, so
  ten photos max. It is **not guaranteed contiguous** — `{0,3,7}` is legal — so
  never infer position from array index.
- `post.media_url` MIRRORS row 0, so **0 rows and 1 photo are the same rendering
  case**. Anything that draws dots at `length >= 1` is wrong; the test is `> 1`.
- Web named the view-model field `photos`, NOT `media` — `FeedPost.media` is
  already the `PostMedia` view model.

## e2e here is timing-sensitive on a COLD Next dev server — budget for the compile
**(2026-08-24, ENG-762)** `e2e/eng-772-profile-label-pill.spec.ts` uses default
5s `expect` budgets. The first hit on `/api/{horses,trainers}/[id]/feed` compiles
the route in dev, which routinely exceeds that, so the spec fails on a cold
server and passes once warm — and the failure MOVES between the horse and
trainer halves, which makes it look like a real regression in whichever file you
just edited. Verified both ways on ENG-762: red once before the change, red once
after, then 3/3 green with the change in place AND green with the file reverted.
- **Do this:** wait for `.post-web` itself with a generous timeout before
  asserting anything inside it, then assert the innards on the default budget.
- Do not conclude "my mapper edit broke the profile feed" from one red run.

## Playwright element screenshots STITCH, and duplicate absolutely-positioned children
**(2026-08-24, ENG-762)** Screenshotting an element taller than the viewport
composites several scroll positions. Anything `position: absolute` inside it
(the photo chip, the dots, the Follow pill) is captured **more than once** and
appears at a bogus offset in the image — it reads exactly like a duplicated-chip
bug. The DOM is fine; the picture is not.
- **Do this:** `page.setViewportSize()` taller than the element before capturing,
  or screenshot the individual card.

## A screenshot proves nothing unless you assert the image DECODED
**(2026-08-24, ENG-762)** Local Storage intermittently serves a bad response for
a freshly-uploaded object. The `<img>` still has its `src`, the test still
passes, and the committed screenshot silently shows a broken-image icon.
- **Do this:** poll `img.complete && img.naturalWidth > 0` before `.screenshot()`.

## Running the dev server breaks `test/marketing-marquee.test.ts`
**(2026-08-24, ENG-762)** That spec reads the PRODUCTION build output under
`.next/server` + `.next/static`. `npm run dev` (including the Playwright
webServer) leaves `.next` holding only `dev/`, so it finds 0 bundles and fails
with no relation to your change.
- **Do this:** run `npm run build` before the final `npm test` after any e2e run.

## Cross-repo parity tickets: read the sibling's `screenshots/<ticket>` branch
**(2026-08-24, ENG-762)** ENG-757 (mobile) had no PR open, but had pushed
`screenshots/eng-757` with its carousel captures. Reading them changed the web
build: a scrim pill behind the dots and a white rim on the active dot were both
dropped because mobile draws neither. A parity ticket's real reference is the
sibling's pixels, not its ticket prose — fetch with
`gh api "repos/<owner>/<repo>/contents/.screenshots/<ticket>/<file>.png?ref=screenshots/<ticket>" -q .content | base64 -d`.
## Signup now consults `phone_in_use` — a LEAKED e2e user bricks every later run
ENG-763 made `POST /api/auth/signup` ask ENG-742's `phone_in_use` RPC before `auth.signUp`,
so a phone number that already belongs to an `app_user` is walled with `409
trial_already_used`. `e2e/trial-start.spec.ts`'s real-signup test uses a **fixed** phone
(`+61 400 000 000`) and only frees it in its `finally` via `deleteUser`. Interrupt that run
(Ctrl-C, a crash, a failure before `userId` is assigned) and the number stays claimed —
after which **every** later run of that test is walled, `waitForURL("**/onboarding")` times
out, and it reads as "signup is broken" rather than "stale fixture". Harmless before this
ticket, because the email is unique per run and a duplicate phone had no effect on signup
succeeding. Recovery, before assuming your change broke signup:
```sh
# who holds it?
curl -s "http://127.0.0.1:54321/rest/v1/app_user?select=id,email,phone&phone=eq.%2B61%20400%20000%20000" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY"
# then DELETE /auth/v1/admin/users/<id> with the service role — it cascades to app_user.
```
Verify a suspected wall directly: `POST /rest/v1/rpc/phone_in_use` `{"p_phone":"+61 400 000 000"}`
as anon returns a bare `true`/`false`, 200, no auth needed.

## `.rx/review/` is gitignored, but three PNGs in it are still TRACKED
`.gitignore:47` ignores the directory, which does **not** untrack files committed before the
rule. `.rx/review/eng-571-{empty,submitting,validation}.png` are tracked, and running
`e2e/trial-start.spec.ts` **rewrites them**, so a reflexive `git add -A` silently drags
another ticket's screenshots into your diff. Check `git diff --stat` against your base before
committing, and `git checkout origin/<base> -- .rx/review/` to put them back. (The
"Screenshot evidence" entry above now points here; the "commit the PNGs" advice it used to
carry is true only of those three legacy files. Current evidence goes to a
`screenshots/<ticket>` branch of PNGs named `eng-NNN-NN-<state>.png`, per
`origin/screenshots/eng-761`, `-762`, `-772`.)

## `test.use({ ...devices[...] })` is rejected inside a `describe`
`Cannot use({ defaultBrowserType }) in a describe group, because it forces a new worker.`
Every Playwright device descriptor carries `defaultBrowserType`, and that one field is the
problem — the parts that matter (`viewport`, `hasTouch`, `isMobile`, `deviceScaleFactor`)
are fine in a describe. Strip it:
```ts
const { defaultBrowserType: _b, ...iPhone13 } = devices["iPhone 13"];
void _b; test.use(iPhone13);
```
This matters because a resized viewport is NOT a touch profile: `setViewportSize({width:390})`
on a desktop context still reports `hover: hover`, so phone-shaped screenshots render the
DESKTOP state (this is how ENG-729 shipped a touch-only bug). Assert
`matchMedia("(hover: none)").matches` inside the test so the profile failing to apply goes
red instead of quietly re-testing desktop.

## The `/start` + `/signin` split-screen has NO mobile breakpoint (pre-existing)
`.auth-page` is a bare `display:flex` with two `flex:1` children and no media query, so on a
390px phone the green brand panel eats ~a third of the width and both columns clip: the
wordmark renders as "stabl", the founder quote wraps to one word per line, and inputs cut off
mid-placeholder. Verified on an iPhone 13 profile against the **unmodified** `/start`, so it
is not attributable to whatever screen you are working on — check a baseline capture before
"fixing" it, and note the client reviews on a phone. Fixing it is a real responsive ticket
against `app/globals.css`, not a drive-by.

## A MIXED `.next` makes the built-output guardrail test fail at random
`test/marketing-marquee.test.ts`'s "ships no confirmation copy in the built output either"
greps `.next`. It is `it.skipIf`-guarded, so in a fresh worktree with no build it simply
SKIPS — which is why a clean checkout looks green and says nothing. Once you have run BOTH
`npm run build` and `npm run dev` in the same worktree, `.next` holds production chunks and
dev chunks together, and the grep intermittently reads stale or half-written output: the
full suite then fails roughly one run in four, always in files with no relationship to your
diff (`marketing-marquee`, `following-screen`), which sends you hunting a phantom regression
in your own change. Fix is not a retry loop:
```sh
pkill -f "next dev"; rm -rf .next && npm run build && npx vitest run
```
After that it is stable — verified 3 consecutive full-suite runs, 801/801. Do this BEFORE
concluding anything about a red suite, and be suspicious of any "flaky" failure whose file
you did not touch. Corollary: a Playwright run leaves a dev server alive, so finish e2e work
before you trust a unit run.

## `FeedPost.label` is REQUIRED, so a dropped mapper line is a compile error (ENG-785)
Five member screens each re-declare their own local `PostRow` **and** their own
row->`FeedPost` mapper (`explore-feed`, `following-screen`, `horses/[id]/horse-posts`,
`trainers/[id]/trainer-posts`, `saved/saved-feed`), so every new `post` column needs an edit
in all five, plus each explicit projection. `label` was declared `label?:` on `FeedPost`, and
that single `?` let it be dropped from all five without `tsc` ever complaining: it took three
tickets (ENG-761, ENG-772, ENG-775) and human eyes to find. It is now `label: string | null`,
proven by deleting each of the five mapper lines in turn (all five fail `tsc`; with the `?`
restored the same deletion compiles green).
**Do this for the next non-optional post column too** rather than reaching for `?`, or the
bug class comes straight back. Keep `?` only for fields that really are sometimes absent.
Two knock-on traps when you tighten a field on `FeedPost`:
* A fixture helper doing `{ ...base, ...overrides }` with `overrides: Partial<FeedPost>`
  widens the field back to `| undefined`. Narrow it AFTER the spread
  (`label: overrides.label ?? null`); setting a default before the spread does not work.
* `app/preview/components/page.tsx` hand-builds `FeedPost` literals and will also stop
  compiling. It is part of the real surface here even though no feed ticket lists it.
