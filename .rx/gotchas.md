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

## Mockups live OUTSIDE the repo — `.rx/mockups.md` is now right, `CLAUDE.md` is not
**Corrected 5 Sep 2026 (ENG-991).** This entry used to send people to
`<workspace>/dev-handover/StablePass-mockups/mockups/web/screens/`. That path has never
existed — `ls` fails on it. `.rx/mockups.md` was fixed by ENG-612 and is now the source
of truth: the real mockups are at `<workspace>/06-stage1-design/mockups/web/screens/`
(verified 5 Sep 2026), and the marketing mockup at
`<workspace>/10-marketing-site/deploy/src/mockup.html`.

`CLAUDE.md` § Design source still claims `docs/dev-handover/mockups/web/*` — **that one
is still stale.** Trust `.rx/mockups.md`, and `ls` before building.

## Resolving anything OUTSIDE the repo: walk from the git common dir, never just cwd
`process.cwd()` is the worktree, and rx workers run in one — often `~/.claude/jobs/<id>/`,
entirely outside the repo tree, where walking up never reaches the workspace. Use:

```ts
execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd })
// -> "<main checkout>/.git"; path.dirname() -> the real repo root, from ANY worktree
```

`test/support/mockup.ts` is the shared implementation — import it rather than writing a
fourth copy. (`--path-format` needs git >= 2.31; wrap in try/catch and fall back to the
cwd walk.)

## A test guard that SKIPS when its fixture is missing will report a false green
ENG-991: the marketing fidelity guards resolved their mockup by walking up from cwd, so
from `~/.claude/jobs/` they vanished — `marketing-shell.test.tsx` went from "36 tests,
1 failed" to **"29 tests, all green"**, and `marketing-home.test.tsx` from "1 FAILED" to
"PASSED". A real red disappeared and the run reported success. Rules:

- **Never `describe.skipIf` / `it.skipIf` on fixture availability.** Call a
  `mockupOrThrow()`-style helper INSIDE the test body so the test still registers and
  goes red with a diagnostic.
- **Pin the guard from outside the block it guards** — a meta-assertion living inside
  the block vanishes with it.
- **Pin execution, not just registration.** vitest runs a *skipped* describe's callback
  at collection time, so `describe.skipIf` still registers every test while running
  none. A registration count alone passes that. `marketing-shell.test.tsx` has both pins.
- Note a `skipIf` keeps the test COUNT identical, so "same count from both locations" is
  not sufficient evidence — compare the pass/fail SET.

## This repo has no test workflow in CI
The only checks on a PR are Vercel builds; `npm test` never runs on CI. The suite is
whatever the author ran locally — which is exactly why a guard that silently no-ops in a
worktree went unnoticed. State the suite result explicitly in the PR body.

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
**(Updated ENG-1001, 6 Sep 2026: there are now TWO prices and `STRIPE_PRICE_ID` is
read NOWHERE. The route picks `STRIPE_PRICE_ID_PROMO` or `STRIPE_PRICE_ID_STANDARD`
server-side from `subscription.promo_passes_used`. Everything below still holds — it
just applies to whichever price id was chosen.)**
The sandbox price is **A$1.00** and production is **A$19.00**. `/api/subscription/checkout`
retrieves the chosen price id and returns `unitAmount`/`currency`; the FE formats every
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
`.rx/review/<ticket>-<state>.png`. Do NOT add NEW PNGs to the diff: `.rx/review/`
is gitignored and fresh evidence ships on a `screenshots/<ticket>` branch instead.
Beware: gitignore does not untrack, so ~76 PNGs committed before that rule are
still tracked and many are REWRITTEN by existing specs (see "`.rx/review/` is
gitignored, but 76 PNGs in it are still TRACKED" below). This widening beyond a
ticket's declared surface is expected for UI tickets, not scope creep. Local
Supabase must already be up — the harness never starts it.

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
(default `app.stablepass.co`), both in `lib/hosts.ts` (and reached from
`app/robots.ts` via `spaceForHost`). ENG-998 added a committed `.env.example`,
which now documents them too. Two traps: they
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

**...but ONLY for DYNAMIC routes — a static route can never trip it (ENG-598).**
Do not predict the error count by grepping for anchors; measure it. In
`@next/eslint-plugin-next/dist/utils/url.js` an app route becomes the regex
`"^" + normalizeAppPath(url) + "$"`, while the href under test goes through
`normalizeURL()`, which **appends a trailing slash**. A static route yields
`^/signin$` tested against `/signin/` → never matches. A dynamic route yields
`^/legal/[slug]$`, whose `[...]` → `((?!.+?\..+?).*?)` substitution is a lazy
wildcard that happily absorbs the trailing slash → matches `/legal/terms/`.
That is why `trial-start-form.tsx` had THREE raw anchors to real pages but only
**2** lint errors: `/legal/terms` and `/legal/privacy` fired, `/signin` never
could. A ticket that says "3 anchors, so 3 errors" is wrong before you start.

## `next/link` silently normalises a trailing slash off the href (ENG-598)
With `trailingSlash` unset (default `false`), `<Link href="/legal/terms/">`
renders `<a href="/legal/terms">`, but a raw `<a href="/legal/terms/">` emits the
slash verbatim. Two consequences: (1) converting an anchor to `<Link>` makes
slash-drift on `/legal/*` structurally impossible, which matters because those
hrefs must stay root-relative to serve on both hosts (ENG-590 decision 1); and
(2) a test asserting rendered hrefs cannot be mutation-checked with a trailing
slash once the element is a `<Link>` — mutate to an ABSOLUTE url
(`https://stablepass.co/legal/privacy`) instead, which is the real host-breaking
failure mode anyway.

## Converting an anchor to `<Link>` is not behaviour-neutral — it adds prefetch
`<Link>` prefetches on viewport entry in a production build, so an anchor→Link
swap is behaviour-neutral in the MARKUP and not in the NETWORK. Measured on
`/start` (ENG-598, `next start` + Playwright counting requests carrying
`Next-Router-Prefetch: 1`): the page fired prefetches for all three linked
routes.

**Decide per link, by route type — the split is the point.**
- `●` prerendered (here `/legal/[slug]`): leave the default on. The prefetch is a
  static payload and genuinely speeds the tap.
- `ƒ` dynamic (here `/signin`): its server component awaits `supabaseServer()`
  then `auth.getUser()`, and there is NO `loading.tsx` anywhere under `app/` for
  the prefetch to stop at, so the default renders the whole page server-side and
  spends a Supabase round-trip on every view of the page holding the link.

**Done in ENG-598:** `prefetch={false}` on the `/signin` link only, with an
in-file comment explaining the asymmetry so nobody normalises it away. Measured
before/after on the same build: `/signin` prefetches 2 → 0 while `/legal/*` kept
prefetching (4 and 7). Verified `prefetch={false}` does NOT downgrade the click
to a full page load — a `window` marker set on `/start` survives the navigation
to `/signin`, i.e. it is still a soft client-side nav; only the speculative fetch
is gone. `prefetch` is also not an attribute, so the rendered DOM stays
byte-identical (1832 chars) and an href-asserting test is untouched by it.

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
- **SUPERSEDED BY ENG-815 (25 Aug 2026).** The view-model field was `photos:
  PostPhoto[]`, resolved client-side. It is now `slideCount: number` from the
  batch mint, and the client never sees `sort_order` at all — the server
  resolves ordinals. The contiguity point above still matters, but it is now the
  BE's problem: `slideCount` is HIGHEST ORDINAL + 1, not a row count, so `{0,2}`
  reports 3 and the client draws a blank middle slide instead of losing photo 2.

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

## `.rx/review/` is gitignored, but 76 PNGs in it are still TRACKED
`.gitignore:47` ignores the directory, which does **not** untrack files committed before the
rule. `git ls-files .rx/review/ | wc -l` returns **76**, and 40+ of them are still rewritten by
current specs (`screenshots.spec.ts`, `checkout.spec.ts`, `expiry-banner.spec.ts`,
`marketing{,-interactive}.spec.ts`, `eng-585-status-truth.spec.ts`, `trial-start.spec.ts`,
`legal.spec.ts`, `signin-cta-sidebar-email.spec.ts`). So a reflexive `git add -A` after ANY
screenshot run silently drags another ticket's PNGs into your diff. Check `git diff --stat` against your base before
committing, and `git checkout origin/<base> -- .rx/review/` to put them back. (The
"Screenshot evidence" entry above now points here; its old "commit the PNGs" advice is dead
for anything new. Current evidence goes to a
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
* Fixture helpers shaped `{ ...base, ...overrides }` with `overrides: Partial<FeedPost>` stop
  compiling when the field is missing from the BASE literal. Add it there, beside its siblings.
  A spread does **not** widen a field the base literal already sets: TypeScript strips
  `undefined` from an optional right-hand property, so a plain `label: null` in the base is
  enough. (Narrowing after the spread compiles too, but it is not required, and writing it as
  though it were teaches a wrong model of spread typing.)
* `app/preview/components/page.tsx` hand-builds `FeedPost` literals and will also stop
  compiling. It is part of the real surface here even though no feed ticket lists it.
The fix defends itself: `test/post-card.test.tsx` carries a `LabelIsRequired<...>` type
assertion that fails the build if anyone puts the `?` back.

## Label/media e2e specs fail when the local DB is behind the be migrations
**Five failures across four spec files**, and they come in two different shapes. Do not assume
the second shape is the first.

*Shape 1 — dies while SEEDING.* `eng-772-profile-label-pill`, `eng-775-saved-label-pill` and one
of `eng-762-photo-carousel` insert the column directly, so they fail loudly at insert with
PostgREST `PGRST204 Could not find the 'label' column of 'post' in the schema cache`. The other
`eng-762` failure is the same shape one table over: `PGRST205 Could not find the table
'public.post_media'`.

*Shape 2 — dies while RENDERING, and names no column at all.* `reaction-save` never mentions
`label` (grep it: zero hits). It fails because `app/api/horses/[id]/feed/route.ts` **names
`label` in its `.select()`**. A projection naming an undeployed column makes PostgREST reject
the WHOLE query with `42703` (HTTP 400), unlike `select *`, which would just omit it. The route
destructures only `data`, so it returns 200 `{"data":[]}` and the screen renders "No updates
yet". The spec then fails on a missing `.post-media-web`, which looks like a UI regression and
is not one. That route documents the trap in-file; read it before debugging a blank feed.

Cause of both: this repo has no `supabase/migrations` of its own. `post.label` ships in the be's
`20260819120001_post_label.sql` (ENG-738) and `post_media` in ENG-762's, so a local
`supabase db reset` drops them and nothing here puts them back. Check before blaming your diff:
```
docker exec supabase_db_stablepass psql -U postgres -d postgres \
  -tAc "select column_name from information_schema.columns
        where table_name='post' and column_name='label';"
```
Empty output means the migration is missing: re-apply the be migrations, then re-run. These
specs passed when ENG-772 and ENG-775 shipped, so a green PR does not mean they stay green
locally. Always baseline the same specs on the merge-base before treating a red as yours.

## Three member e2e specs are RED on `feature/round6-v1` — they die in their own SEED (ENG-794)

`e2e/eng-772-profile-label-pill`, `e2e/eng-775-saved-label-pill` and
`e2e/reaction-save` fail on the round-6 tip. Measured at `4dbefe7` and again on
ENG-794's branch: **3 failed / 2 passed** across those three files (5 tests), and
**9 failed / 105 passed** across the whole Playwright suite — identical on both,
so they are not anyone's regression.

**They fail in their service-role seed, before any page is loaded.** The error is:

```
{ code: 'PGRST204', message: "Could not find the 'label' column of 'post' in the schema cache" }
```

The specs INSERT a post with `label: "Trackwork"`, and the local `post` table has
no `label` column — `information_schema` lists 19 and `label` is not one. The
migration `20260819120001_post_label.sql` (ENG-738) exists only on unmerged
`stablepass-be` worktrees, never on be `main`. A transient
`42501 permission denied for table trainer` has also been seen from the same seed
when the local stack was in a half-restarted state.

**Do NOT conflate this with the 42703 projection trap.** That trap is real and
documented above, but it applies to a `.select()` naming an undeployed column,
where PostgREST rejects the query and the ROUTE turns it into a silent empty
list. These specs never get that far — they cannot even write their fixture. If
you go looking for a blank feed you will waste the afternoon.

**The consequence worth knowing:** while this holds, the three specs give the
five member feed screens **zero** end-to-end coverage. Anything touching those
screens is covered by vitest and static comparison only, so say so in the PR
rather than implying the e2e red is understood and harmless.

**Do this:** baseline before blaming your diff, and do NOT deploy the be
migration yourself — the local Supabase stack is shared across every worktree
(see the BE serialization rule). Disclose, and note that CI must re-run these
once ENG-738 lands.

## `npm test` alone can FAIL `marketing-marquee`, and a dev server is why

`test/marketing-marquee.test.ts` ("ships no confirmation copy in the built output
either") scans `.next` for bundle files and asserts `bundles.length > 0`. The
`existsSync` guard documented above skips it when `.next` is absent — but a
Playwright run (or any `npm run dev`) creates a `.next` with **dev** output, so
the guard passes and the filter then finds zero production bundles. The test
fails with `expected 0 to be greater than 0` and looks like a regression in code
you never touched.

**Do this:** run the documented gate in order — `typecheck && build && test`. After
a `next build` the file goes green. Two suite skips also disappear once the build
output exists, so the honest full-suite number on round-6 is 873/873, not
858 + 2 skipped.

## The five feed mappers are now ONE — add a `post` column in `lib/feed/post-row.ts` (ENG-794)

`postIntrinsics()` + `POST_INTRINSIC_COLUMNS` own the ten post-intrinsic fields
for all five member screens and both profile routes. A new `post` column the card
renders needs `lib/feed/post-row.ts` (row type + projection + key + mapper) and
`components/types.ts` (the view model) — and nothing else. Identity/context
(`horseId`, `horseName`, `trainerName`, `trainerId`, `stableName`,
`stableLocation`, `bookmarked`) is deliberately NOT shared; those diverge per
screen for real reasons. Don't widen the helper to cover them.

The return type is `Required<Pick<FeedPost, PostIntrinsicKey>>` on purpose:
`title?`, `body?` and `slideCount?` are optional on `FeedPost`, so a plain `Pick`
would let the shared mapper drop one and still compile.

## `<img>` recovery: the HTTP cache makes expiry bugs look unreproducible (ENG-813, 25 Aug 2026)

**Symptom:** a minted-URL expiry bug "cannot be reproduced" by clicking through the app.
**Cause:** an already-painted image survives the HTTP cache, so nothing re-requests it. The
break only appears when something DOES re-request after the TTL — a tab left open, a bfcache
restore, a re-mount.
**Do this:** never try to wait out a real TTL in a test. Drive `fireEvent.error(img)` against a
mocked fetch. The element's `onError` is both the production mechanism and the test hook.

Two related traps on the same ticket:

1. **A cached GET silently no-ops a re-mint.** The video poster re-mint hits the SAME
   `/api/posts/:id/playback?posterOnly=1` URL the initial page resolve already fetched. Without
   `cache: "no-store"` a cached 200 returns the poster that just failed — the single retry
   becomes a guaranteed no-op AND the server's re-gate is skipped. `ok()` in
   `lib/api/envelope.ts` sets no `Cache-Control`, so this is one header away from real.
2. **`react-hooks/refs` errors on a ref mutation during render.** The documented "adjust state
   on a prop change" pattern (render-phase `setState`) is fine, but a `ref.current = x` beside
   it is a lint ERROR, not a warning. Move just that line into a `useEffect` keyed on the same
   tracked prop.

**Test-strength note:** a presentational component's *wiring* is easy to leave untested. Every
media case in `test/post-card.test.tsx` uses `posterUrl: null`, which short-circuits before an
`<img>` exists, and `components/media-player.tsx` has no test file at all. A wrong `postId`
there leaks nothing (the BFF re-authorises) but silently kills the feature in production with a
green suite. Mutation-check the wiring, not just the logic.

## Subagents sharing a worktree corrupt each other's test runs (25 Aug 2026)

**Symptom:** intermittent single-test failures and test COUNTS that change between back-to-back
`npm test` runs in the same tree (53 files/789 → 54 files/796).
**Cause:** a review subagent working in the same worktree was writing scratch/probe test files
(`test/zz-*.test.tsx`) and temporarily mutating source to prove a test's strength. A concurrent
`npm test` sees the tree mid-mutation.
**Do this:** never run the verification suite while a reviewer/labour agent is live in the same
worktree. Serialise them, and before committing always `git status --porcelain` and delete any
`test/zz-*` scratch files — they will otherwise be staged and inflate the diff. A stalled
subagent's transcript file stays at 179 bytes and its mtime does NOT update while it works, so
mtime is not a liveness signal; and an agent you spawned may not be stoppable via TaskStop
("owned by" error).

## A revoked bucket does not throw — it renders a carousel of nulls (ENG-815, 25 Aug 2026)

**Symptom:** after merging `main` into `feature/round6-v1`, the multi-photo
carousel compiles, type-checks, passes `tsc`, renders its dots and its `n/m`
chip, and shows no photograph past the first. No error anywhere.

**Cause:** ENG-799 made `signPhoto` / `signPhotoMap` **deny-by-construction** for
`POST_MEDIA_BUCKET` — they `return null` / `return out` early rather than
throwing (`lib/storage/photos.ts`). Round 6's `lib/post-media.ts` still called
`signPhotoMap(sb, POST_MEDIA_BUCKET, …)`, and that file did not conflict during
the merge because it exists only on one side. Git kept it silently, and a
mechanical resolution therefore ships dead code that looks alive.

- **Do this:** after any merge that crosses a cutover, list the files that exist
  on ONE side only and read them against the other side's new invariants. The
  conflicting files are the ones you will look at anyway; the non-conflicting
  ones are where the silent regression hides.
- The general shape: a guard that degrades quietly is the right call at runtime
  and a trap at merge time. Grep for callers of anything that became
  deny-by-construction, not just for compile errors.

## The web carousel e2e needs the be on `feature/round6-v1`, not `main` (ENG-815, 25 Aug 2026)

`e2e/eng-762-photo-carousel.spec.ts` drives slides through
`POST /api/posts/media` → the be `post-media` edge function. The
`{ postId, slideIndex }` mode and `slideCount` landed on the be's
`feature/round6-v1` (`af68205`) and are NOT on be `main`.

- **Symptom if the local edge runtime serves the wrong branch:** every post reads
  as single-photo (no dots), or `post.label` comes back `PGRST204 Could not find
  the 'label' column`. Both look like web regressions and are not.
- **Check first:** `docker inspect supabase_edge_runtime_stablepass` shows which
  be worktree is bind-mounted; `git -C <that worktree> branch --show-current`
  names the branch actually being served.
- The stack is SHARED across all be worktrees (see the BE loop-serialization
  rule), so a web worker must not repoint it to suit itself.

**Degradation is safe, and that was verified rather than assumed:** web running
against a be without the slide mode gets `slideCount: undefined` → 1 → no
carousel, and a `{postId, slideIndex}` request 400s → `null` → blank slide. No
crash and no wrong photo, so the web PR can land before the be one.

## `horse.sex` is male/female + `is_gelded` — old e2e seeds die at the fixture (ENG-815, 25 Aug 2026)

ENG-304's `horse_sex_check` is `sex IS NULL OR sex = ANY('{male,female}')`, with
gelding moved to a separate `is_gelded` boolean. Every pre-ENG-304 e2e seed says
`sex: "gelding"` (or `"mare"`), which now fails with `23514` at the `if
(horseError) throw horseError` line — **before a single assertion runs**, so the
spec reports as a product failure.

- **Do this:** when a merge brings a schema migration onto a branch that carries
  its own e2e specs, grep the specs for every column that migration touched.
  `main`'s `e2e/screenshots.spec.ts` already had the fix; three round-6 specs did
  not, and only one commit separated them.
- Same class as the `foaling_year: new Date().getFullYear() - 5` seeds, which
  ENG-617's repo-wide "no date arithmetic" guard flags in `e2e/` too. Use an
  absolute year in fixtures.

## `getByLabel("Password")` is AMBIGUOUS since the eye toggle (ENG-956, 4 Sep 2026 — swept ENG-1062, 10 Sep 2026)

`7cc153e` (1 Sep) added `components/password-input.tsx`, whose reveal button is
`<button aria-label="Show password">`. Playwright's `getByLabel` matches it as
well as the `<input id="password">`, so **every** sign-in helper written as
`page.getByLabel("Password").fill(...)` now dies with `strict mode violation:
resolved to 2 elements` — *before* any assertion, so it reads as a product
failure on whatever screen the spec was testing.

- **Do this:** `import { fillPassword } from "./helpers/sign-in"` and call
  `await fillPassword(page, pw)`. Never a label query.
- **SWEPT AND GUARDED (ENG-1062, 10 Sep 2026).** The sweep is done — 22 call
  sites across 12 specs now go through `e2e/helpers/sign-in.ts`, which targets
  `#password` and asserts the locator resolved to exactly ONE node before it
  types. `test/e2e-password-locator-guard.test.ts` fails the vitest suite if any
  `e2e/**` file reintroduces a label query the reveal toggle could match, so this
  cannot go dark again in a repo with no CI e2e job.
- Note `getByLabel("New password", { exact: true })` and
  `getByLabel("Confirm new password")` in `eng-953-password-reset` are FINE and
  are deliberately not flagged: neither is a substring of "show password".

## A mass e2e failure is rarely ONE cause — classify by first error line (ENG-1062, 10 Sep 2026)

ENG-1058 reported all 68 Playwright failures as the `getByLabel("Password")`
strict-mode violation. Grouping the log by first error line showed only **33**
were: the other 35 were pre-existing failures of five unrelated kinds. Fixing the
locator took the suite 68 → 55 red, not 68 → 0, because unblocking the login step
also *revealed* ~20 tests that had been dark behind it and fail for their own
reasons.

- **Do this:** before scoping a "one root cause" fix, `grep` the run log for the
  first `Error:` of every failure and count the distinct shapes. A ticket that
  promises green off one fix is mis-scoped if that count is > 1.
- Corollary: a fix that unblocks an early step *raises* the visible failure count
  in the specs behind it. That is progress, not a regression — report
  passed-count (99 → 112), not just failed-count.

## A seeded e2e member is NOT entitled any more — trials are gone (ENG-1062, 10 Sep 2026)

Most signed-in specs seed a member with `auth.admin.createUser({ email_confirm:
true })` and assume the trigger provisions an entitled **trial**. It no longer
does. The local `subscription` table holds **zero** `trialing` rows (99 `lapsed`
/ 51 `active` / 18 `canceled`) — the pricing epic (ENG-1023…ENG-1029) moved the
product to a paid, renewing subscription and the trial status went with it.

**Symptom:** the spec signs in fine, then every feed/profile assertion fails with
`element(s) not found` for `.post-web`, `.post-media-web`, a heading, etc. The
page actually rendered the access wall — *"You don't have a subscription yet /
Subscribe to see every update… It renews monthly and you can cancel any time"* →
`Get full access`. It reads as a UI regression and is not one.

- **Do this:** dump Playwright's `test-results/**/error-context.md` — it carries
  the full a11y snapshot of the page at failure and names the wall in one line.
  Then seed the subscription row your spec needs (`status: "active"` with a
  `current_period_end` in the future; `trial_ends_at` is NOT NULL, so still pass
  a date) instead of trusting the createUser trigger.
- This is why `video-poster`, `reaction-save`, `eng-772`, `eng-775`, `eng-762`,
  `eng-956/957/959/960/961` and the `screenshots` member specs are red on
  `feature/web-media-v1` — a fixture-contract gap, not a media defect.

## A PostgREST builder is a THENABLE, not a Promise — `.catch()` is not a function (ENG-956, 4 Sep 2026)

Best-effort e2e teardown written as
`await admin.from("horse").delete().eq(...).catch(() => {})` throws
`TypeError: …eq(...).catch is not a function` and fails the test *after* every
assertion passed. `PostgrestFilterBuilder` implements `then`, not `catch`.
`admin.auth.admin.deleteUser(...)` IS a real Promise, so the two sit next to
each other in the same `finally` and only one of them works.

- **Do this:** wrap PostgREST teardown in `try { … } catch {}`, not `.catch()`.

## The guardrail-2 owner grep trips on the word "ownership" (ENG-956, 4 Sep 2026)

`test/owner-pii-guard.test.ts` greps every member component for `/\bowner/i`.
Mobile's Shares empty state — "Horses with ownership shares for sale will show
up here." — matches it, so porting that copy verbatim fails the guard.

- **Do this:** allow-list the *sentence*, not the word: scrub the literal string
  out of the source before scanning and leave `/\bowner/i` untouched. A
  `/\bowner(?!ship\b)/` lookahead is the tempting fix and is **wrong** — it
  exempts the whole word family, so a future `sb.from("ownership")` or
  `ownership.email` (the natural spelling for a syndicate entity, on the shares
  surface of all places) passes the guard silently. Three independent reviews
  converged on the string form.

## A guard test can assert the BUG once its ticket is reversed (ENG-956, 4 Sep 2026)

`test/shares-segregation-guard.test.ts` (ENG-831) required `"Contact trainer"`
to be PRESENT in `post-card.tsx`. R8/ENG-862 deleted that CTA, so the guard
became a test that fails the fix and passes the defect — and it also read
`shares-feed.tsx`, which the same ticket deletes (ENOENT).

- **Do this:** when a ticket reverses an earlier decision, `grep` the test tree
  for guards that PIN the old behaviour before assuming the suite is a neutral
  gate. Rewriting one is in scope; check what coverage the old assertion also
  carried (this one silently dropped `prize_money|odds|price_cents` from
  `post-card.tsx` — `prize_money_cents` is a real deployed column).

## Asserting a projection against its own exported constant is a tautology (ENG-956, 4 Sep 2026)

`expect(chain.select).toHaveBeenCalledWith(SHARES_HORSE_SELECT)` looks like it
pins the 42703 rule from the entries above. It does not: adding an undeployed
column to the constant leaves the suite green, because both sides move together.
Measured, not assumed.

- **Do this:** spell the projection out as a LITERAL string in the test — the
  same way the disclaimer copy is pinned to a typed-out `VERBATIM`.

## `app/manifest.ts` injects the manifest link into EVERY document
The idiomatic Next file convention (`app/manifest.ts`) makes Next add
`<link rel="manifest">` to every page in the app, marketing included. In this repo
that advertises the marketing apex as an installable standalone app whose
`start_url: "/"` is the brochure, not the member app — i.e. it changes behaviour on
the marketing surface without editing a single marketing file. Use a static
`public/manifest.webmanifest` + `metadata.manifest` on `app/(member)/layout.tsx`
instead, so only app-space documents link it. Verify with
`curl -s localhost:<port>/legal/privacy | grep manifest` (expect nothing).

## `.trial-label` / `.trial-detail` are SCOPED to `.trial-banner-web`
The rules are `.trial-banner-web .trial-label`, not bare class selectors. Applying
`className="trial-label"` outside that parent silently renders unstyled browser
defaults — no error, no failing test, and it survives review unless someone LOOKS at
a screenshot. Either nest inside `.trial-banner-web` or restate the values. This is
the concrete case for "screenshot every UI change before you believe it".

## iPad detection: three false positives a touch+platform check alone lets through
`platform === "MacIntel" && maxTouchPoints > 1` is necessary but not sufficient.
1. **iPhone with "Request Desktop Website"** reports the Macintosh UA *and* `MacIntel`
   *and* touch points — identical to an iPad on every UA signal. Discriminate on
   `Math.min(screen.width, screen.height)`: iPads are >= 744, the largest iPhone is
   430, and screen size is immune to the desktop-mode switch (the viewport is not —
   split view would break it).
2. **WebKit in-app browsers** (Instagram, Facebook `FBAN/FBAV`, LinkedIn, `GSA/`,
   DuckDuckGo `Ddg`) contain `Safari` and none of the Chrome tokens, so they pass a
   naive Safari check — but they have no Share → Add to Home Screen, so the
   instruction is a dead end. Exclude by product token.
3. **`SFSafariViewController` opened by a native app forwards a byte-identical Safari
   UA.** It is therefore UNDETECTABLE by user agent. Do not write "this cannot appear
   in the native app" — it can. The native shell must declare itself positively
   (query param / storage key / UA product token) and the web side must honour it.

## Playwright: `getByLabel("Password")` is ambiguous since the reveal-password toggle
The eye control is `aria-label="Show password"`, which the accessible-name match also
picks up → strict-mode violation. Use `getByRole("textbox", { name: "Password" })`.
Several older specs in `e2e/` still use the bare label and are stale.

## Baseline a "pre-existing" test failure at the SAME worktree depth
`test/marketing-{home,shell}.test.tsx` resolve the mockup via a path relative to the
checkout, and `it.skipIf(!MOCKUP)` SKIPS them when it does not resolve. A baseline
worktree in `/tmp` therefore reports green and looks like your change caused the red.
Create the baseline under `.claude/worktrees/` so the depth matches. (Both currently
fail on `main` — mockup byte-drift, ENG-977 territory.)

## `.gitignore`'s `.env*` silently swallows `.env.example`
The ignore rule is `.env*` (unanchored), so a newly created `.env.example` is
ignored and `git add` does nothing — the file just never appears in the diff.
`git check-ignore -v .env.example` is confusing here (it prints the *negation*
rule once one exists); the reliable signal is `git status --short`, since ignored
files never show up there at all. Fix is one line **after** the `.env*` rule:
`!/.env.example` (root-anchored, so it cannot re-include a nested `.env.example`).
Verify with `git check-ignore -q` on `.env`, `.env.local` and
`.env.production.local` — all three must stay ignored. Expect any ticket whose
surface is `.env.example` to need this `.gitignore` line too; it is an
unavoidable widening, not scope creep.

## `vercel env add <NAME> preview` cannot be completed non-interactively
Adding a **Preview** var bails with
`{"status":"action_required","reason":"git_branch_required"}` — and it does this
*even when you run the exact command its own `next[]` hint tells you to*
(`vercel env add NAME preview --value <v> --yes`). CLI 50.37.3. `production` and
`development` take a piped stdin value fine; only `preview` is broken, because it
wants to know whether the var is branch-scoped or all-branches.
Workaround — go straight at the REST API with the CLI's own token:
```
TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.local/share/com.vercel.cli/auth.json'))['token'])")
curl -X POST "https://api.vercel.com/v10/projects/$PROJECT_ID/env?teamId=$TEAM_ID&upsert=true" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"NAME","value":"v","type":"encrypted","target":["preview"]}'
```
`projectId` / `orgId` are in `.vercel/project.json`. Also note this CLI takes only
ONE environment per `env add` — `... production preview development` is an
"Invalid number of arguments" error, not a multi-target add.

## Stripe: there is no `stripe` CLI on this machine — use the REST API
Tickets are written against `stripe prices retrieve …` / `stripe prices list`, but
the CLI is not installed. Use `curl -u "$SK:" https://api.stripe.com/v1/...` with
the key read out of `.env.local`. Always assert `livemode: false` in the response
before believing you were in the sandbox — the key prefix (`sk_test_`) and
`livemode` are the two checks worth making explicit in any ticket comment.
`tax_behavior` on a price is **immutable once set** to `inclusive`/`exclusive`,
so set it correctly at creation (AU prices are GST-inclusive) rather than
planning to fix it later; it does not enable Stripe Tax by itself.

## Preview deploys have NO Stripe env at all
`STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` exist for
Production and Development only. Any preview deployment therefore 502s
`stripe_unavailable` on `/api/subscription/checkout` no matter which price ids
are configured. Don't debug a preview checkout as a code bug, and don't assume a
"set it for Preview + Production" ops ticket made preview functional.

## `e2e/checkout.spec.ts` is RED on `feature/pricing-v1` — all 3 tests, pre-existing (ENG-1001, 6 Sep 2026)
The reveal-password toggle (commit `7cc153e`, on the base) made `getByLabel("Password")`
ambiguous, and this spec still uses the bare label. All three ENG-567 tests therefore
die inside `signIn()` at line 56, **before** ever reaching `/checkout` — so they tell
you nothing about the checkout screen and must not be read as a regression from a
checkout change. Use `getByRole("textbox", { name: "Password" })`, as
`e2e/eng-1001-checkout-pricing.spec.ts` does.
- **Do this:** before blaming a checkout diff for a red `e2e/checkout.spec.ts`, check
  whether the failure is at `signIn`. Fixing the spec is a one-line change, but it
  belongs to whoever owns that file's surface.

## grill-me already committed a `.rx/specs/<date>-<ticket>-design.md` — READ IT BEFORE WRITING (ENG-1001, 6 Sep 2026)
The per-ticket design spec named in a ticket's surface is frequently ALREADY on the
base branch (the epic's docs commit lands a short pre-build version). A `Write` to
that path silently replaces it, and the pre-build reasoning is gone from the diff with
nothing flagging the loss.
- **Do this:** `git show origin/<base>:.rx/specs/<file>` first. The as-built spec should
  supersede and absorb it, not quietly overwrite it — and say so in the PR.

## `promo_passes_used` counts EVERY paid pass, not just discounted ones
So the promo test is a plain `promoUsed < 6` and the counter keeps climbing past the
threshold — `promoRemaining` must be clamped with `Math.max(0, …)` or a member on
their tenth pass reads a negative number. Confirmed in the be migration comment and in
`.rx/specs/2026-09-05-paid-only-subscription-epic-design.md`.

## `getByLabel("Password")` is AMBIGUOUS in Playwright — every e2e spec uses it
**(2026-09-06, ENG-1002)** `/signin` gained a show/hide control that is a
`<button aria-label="Show password">` inside the password field's label, so
`page.getByLabel("Password")` resolves to TWO elements and Playwright's strict
mode throws `strict mode violation`. This is not local to one spec: `e2e/`'s
`screenshots.spec.ts` (5 call sites) and `checkout.spec.ts` all still use the
ambiguous form, so the sign-in helper of every older spec is broken.
- **Do this:** `await page.locator("#password").fill(PASSWORD);` (the input
  carries `id="password"`), and prefer `getByRole("button", { name: "Sign in",
  exact: true })` for the submit.
- Only `e2e/eng-1002-cancel.spec.ts` was fixed — repairing the rest is its own
  ticket, since some of those specs are broken for OTHER reasons too (below).

## ENG-999 retired `trial` — every fixture seeding `status: 'trial'` now 23514s
**(2026-09-06, ENG-1002)** `20260905120000_paid_only_subscription.sql` narrowed
the CHECK to `status in ('active','lapsed','canceled')` and made
`has_content_access()` grant `{active, canceled} + expiry`. Two consequences that
bite anything written before it:
- an **e2e seed** of `status: 'trial'` is now a constraint violation, not a
  fixture (`e2e/eng-585-status-truth.spec.ts` had one; fixed).
- a **unit fixture** of `status: 'trial'` used to mean "entitled" and now means
  "walled" — silently, since it is just data. Six suites (`feed-route`,
  `following-screen`, `horses-route`, `saved-feed`, `shares-browse-segregation`,
  `trainers-route`) used it as their entitled fixture and went red. Re-point them
  to `status: 'active'` with the same date on `current_period_end`.
- `e2e/expiry-banner.spec.ts` and `e2e/trial-start.spec.ts` seed trials through
  the SIGNUP flow and cannot be fixed this way — they are dead until `/start` is
  reworked.
- Still stale afterwards: `components/access-wall.tsx` tells a member who never
  paid "Your free trial has ended". Needs its own ticket.

## `.rx/mockups.md` is STILL wrong — the real mockups are under `dev-handover/`
**(2026-09-06, ENG-1002)** The manifest points at
`<workspace>/06-stage1-design/mockups/web/` and asserts that
`dev-handover/StablePass-mockups/mockups/web/` "has never existed". As of today
the opposite is true: `06-stage1-design/` does not exist and
`/home/reno-fathoni/Documents/rx/stable/dev-handover/StablePass-mockups/mockups/web/screens/`
holds all eight screens. **`ls` the path before building against it** — this
manifest has now been wrong three times in three different directions.

## Unit tests live in `test/`, never colocated — grill-me keeps emitting colocated paths
**(2026-09-06, ENG-1002)** The ticket's Surface asked for
`app/api/subscription/cancel/route.test.ts` and `lib/api/access.test.ts`. All 70
test files in this repo live in `test/` and none are colocated; vitest would run
a colocated file, so this fails silently as a convention drift rather than an
error. Put them in `test/<area>.test.ts` and note the deviation on the ticket.

## jsdom leaks a controlled `<textarea>`'s value into `textContent`
**(2026-09-06, ENG-1002)** In a real browser a textarea's `.value` (the dirty
value) and its `textContent` diverge; in jsdom, once a value is typed via a
dispatched input event it shows up in `element.textContent`/`innerHTML` too. So a
guardrail assertion like "the member's comment is not rendered anywhere in the
DOM" is not meaningful while the field that legitimately holds it is still
mounted — strip form controls from a DOM clone before asserting, or the test is
either falsely red or vacuously green depending on phrasing.

## PostgREST returns timestamptz as `+00:00`, not `Z`
**(2026-09-06, ENG-1002)** A fixture seeded with `new Date().toISOString()`
(`…761Z`) reads back from PostgREST as `…761+00:00`, so a string `toBe()`
comparison fails on an identical instant. Compare with `Date.parse()` on both
sides in any e2e assertion that round-trips a timestamp through the API.

## A loaded box makes `test/marketing-marquee.test.ts` time out (5s, scans `.next`)
**(2026-09-06, ENG-1002)** Its last test walks the whole 24MB `.next/{server,static}`
tree under vitest's default 5s timeout. With a sibling worktree's suite running
concurrently it times out; alone it passes in seconds. Before believing a red
here, re-run the file on its own — and check whether another worker is running
(`ps aux | grep vitest` shows the other checkout's path).

## STALE: "there is no cancel route" — ENG-1002 brought it back
**(2026-09-06, ENG-1002)** An earlier section of this file, `.rx/guardrails.md` #3
and `CLAUDE.md` all still say the pass has **no cancel route** (true after ENG-567
deleted it) and that the gate is `status in {trial, active}`. Both stopped being
true on `feature/pricing-v1`:
- `POST /api/subscription/cancel` exists again, with different semantics — it
  calls the `cancel_own_subscription()` RPC, not a table update.
- the gate is `{active, canceled}` + expiry (`has_content_access()`, ENG-999).
`CLAUDE.md` and `.rx/guardrails.md` are outside ENG-1002's surface and are left
for a doc ticket — but do not trust either on subscription state until then.

## Cancelling with a NULL `current_period_end` revokes access immediately
**(2026-09-06, ENG-1002)** `cancel_own_subscription()` stamps
`current_period_end = coalesce(current_period_end, now())`, which is deliberate
(a `canceled` row with a null period would grant access forever and
`subscription-expiry-sweep` only touches `status='active'`, so nothing could ever
reclaim it). The UI consequence is easy to miss: `active` + null period is the
just-paid / webhook-in-flight window and is ENTITLED, so a naive
`canCancel = entitled && status === "active"` offers the control there — and
cancelling revokes access on the spot until the late webhook restores it. Any
future cancel affordance must require a non-null `current_period_end`.
## RESOLVED by ENG-1003 — signup no longer calls `phone_in_use`
The "a LEAKED e2e user bricks every later run" entry above is **dead as of ENG-1003**.
`POST /api/auth/signup` no longer consults the RPC at all (the trial it rationed is
retired), so a stale `+61 400 000 000` in `app_user` walls nothing and the recovery
`DELETE` in that entry is chasing a ghost. The RPC and `idx_app_user_phone` still
exist server-side — ENG-742's backstop still degrades a duplicate phone to NULL — so
`lib/format/phone.ts` and its parity test stay; they simply have no production caller
now. A repeat phone signs up normally, by decision.

## `_archive/` does NOT always supersede the live mockup — read the file's own header
The manifest convention says an archived mockup supersedes the live one. On
`mockups/web/screens/03-trial-start.html` that is **backwards**: the live file's header
says *"revised 15 Aug 2026 … Previous version archived at
`_archive/03-trial-start.2026-08-15.html`"*, and the archive is the older **three-field**
screen (Your name / Email / Phone) against the live six-field one the app actually
implements. Building to the archive would have deleted first/last name, postcode and
password from `/start`. Check the live file's own header before applying the convention —
it names its predecessor when it has one. (Also still true, verified again 6 Sep 2026:
`.rx/mockups.md` points at `06-stage1-design/mockups/web/`, which does not exist. The real
tree is `dev-handover/StablePass-mockups/mockups/web/`, OUTSIDE this repo.)

## A copy-guard test is only as good as its pattern list — mutate it before trusting it
ENG-1003's `test/no-trial-copy.test.ts` originally banned `/free trial/`, `/30 days free/`
and `/30 days, on us/` — and the single largest piece of trial copy it was written to keep
out, the aside quote *"30 days on us — no credit card, no auto-charge"*, matched **none** of
them (no comma, and "no credit card" is the pitch without ever saying "trial"). It passed
green while the thing it guarded against could be pasted straight back. Two rules:
1. **Mutation-test a grep guard**: restore the exact string the ticket deleted and confirm
   the test goes RED. Green after that mutation means the guard is decorative.
2. **Never key an allowlist on line numbers** when the scanner strips comments. A plain
   `raw.replace(/\/\*[\s\S]*?\*\//g, "")` deletes the newlines *inside* the comment, so
   `i + 1` is an index into the stripped body, not a file line — it drifts the moment
   anyone adds a multi-line JSX comment, and it silently ALLOWS whatever else lands on the
   allowed index. Blank the comment out instead — `.replace(/[^\n]/g, "")` inside the
   callback — and key the allowlist on the offending **text**.

## An absence-only assertion is a tautology once the call site is deleted
`expect(rpcMock).not.toHaveBeenCalled()` after the RPC call has been removed from the route
can never fail, and does not prove the acceptance criterion it was written for ("a repeat
phone now creates an account normally"). Pair every "X is no longer called" assertion with
the positive control in the same test — assert the 201 as well — or the test file grows
green assertions that measure nothing. Same for `not.toHaveBeenCalledWith(...)` sitting
above `not.toHaveBeenCalled()`: the second strictly subsumes the first.

## `active` + PAST `current_period_end` is a ROUTINE state, not corrupt data
`lib/api/access.ts` `hasAccess()` returns entitlement for `active`/`canceled` purely on
the date: status is flipped when the be `stripe-webhook` lands, **not** at expiry. So an
`active` row routinely outlives its `current_period_end` (ENG-585 shipped a user-visible
bug in exactly that window). Any ticket reasoning about "an active member" must decide
what it does in that window — do not write it off as an upstream data problem. It bit
ENG-1007, where it is the difference between a rare edge case and the most motivated
users of the early-renewal path.

## Checkout Branch B's `newPeriodEnd` fallback is CONTRACTED — do not quantise it
`test/subscription-routes.test.ts` asserts "a PAST current_period_end falls back to now —
never extends from a stale date" against the **real clock** with a ±5s tolerance. Rounding
that fallback onto any grid (e.g. `IDEMPOTENCY_BUCKET_MS`, to stabilise an idempotency
digest) shifts a money-bearing date and fails that test non-deterministically — it passes
only when wall-clock happens to sit near a bucket boundary. Related trap: quantising only
the DIGEST while sending the true params is worse, not better — same key + different params
is precisely what Stripe rejects (`idempotency_error`), turning a rare double charge into a
deterministic 502.

## A frozen-clock idempotency test cannot fail
`vi.setSystemTime()` with no advance makes any deterministic key implementation pass —
including a broken one that digests `Date.now()` straight in. For "two tabs" races, always
`vi.advanceTimersByTime(...)` between the two calls, and start **mid-bucket** (e.g.
`T00:03:00Z`) since a round time like `T00:00:00Z` sits exactly on the 10-minute boundary
and the advance would straddle it. Caught in ENG-1007 review, not by the green suite.

## `toHaveBeenCalledWith` is arity-exact — adding an options arg breaks callers
Adding a second argument to a mocked Stripe call (e.g. `paymentIntents.create(params,
{ idempotencyKey })`) fails every existing `toHaveBeenCalledWith(objectContaining(...))`
single-arg assertion, even though the first arg still matches. Assertions that index
`.mock.calls[n][0]` are unaffected. Expect to update a handful of pre-existing tests; it
is a forced mechanical edit, not a regression.
## Retiring a shared copy string: grep the REGEX forms, not just the literal
ENG-1008 renamed `WALL_COPY.trialEnded` → `neverSubscribed` and changed its title.
Grepping the repo for the literal `"Your free trial has ended"` found two pinning
tests. The suite then failed on **three more** — `test/explore-feed.test.tsx`,
`test/following-screen.test.tsx`, `test/saved-feed.test.tsx` — which pinned it as
`findByText(/your free trial has ended/i)`, lower-cased and slash-delimited, so the
literal grep missed all three. A fourth form hides in the `it("...")` NAME
(`"shows the free-trial-ended wall"`), which no assertion grep finds at all.
Before changing any string rendered by a shared component, grep case-insensitively
for the phrase with `.` between words (`free.trial.has.ended`) **and** for a
hyphenated slug of it (`free-trial-ended`), and check test names as well as bodies.
Better: have the anchor read the constant. Those five call sites used the wall title
as the positive "the 402 path actually rendered" anchor, which does not need the
literal at all — they now import `WALL_COPY` and assert
`WALL_COPY.neverSubscribed.title`, so the next copy change cannot break them.

## Clearing a `PENDING_ROOTS` entry: PROMOTE the root, don't just delete it
`test/no-trial-copy.test.ts` scans two lists — `FUNNEL_ROOTS` (zero hits allowed) and
`PENDING_ROOTS` (hits allowed only if they match a named string). A root in **neither**
list is not scanned at all. So "delete your entry from PENDING_ROOTS when your ticket
lands" is half an instruction: deleting alone silently drops the root from coverage at
the exact moment it becomes clean. ENG-1008 moved `components` and `app/onboarding`
into `FUNNEL_ROOTS` instead, which is what the file's own comment says should happen
("that root gets the same zero bar as the funnel"). Check the same shape on any other
allowlist-plus-strict-list guard before assuming a deletion tightened anything.

## `getByLabel("Password")` is ambiguous repo-wide — and NOT because of the markup
`getByLabel` matches the accessible name as a **case-insensitive substring**, so
`"Password"` also matches the reveal control's `aria-label="Show password"`
(`components/password-input.tsx`) → *strict mode violation, resolved to 2 elements*.
Get the cause right, because it decides the fix: the button is **not** inside the
`<label>` — in `app/signin/sign-in-form.tsx` the `<label htmlFor="password">` and the
`<PasswordInput>` are **siblings** inside `.input-group`, and the button lives in
PasswordInput's own wrapper. So restructuring the markup fixes nothing;
`getByLabel("Password", { exact: true })` or `page.locator("#password")` both do.

`eng-956`, `eng-1001` and `eng-1002` had each already worked around it locally with
`page.locator("#password")`, and ENG-1008 did the same for `eng-585`. Still carrying
the broken form: `checkout`, `expiry-banner`, `trial-start`, `eng-762`,
`signin-cta-sidebar-email` and `screenshots.spec.ts`.
Consequence worth noting: a spec that cannot reach its assertions is not a guard, and
this is why the stale wall string ENG-1002 deliberately pinned in eng-585 never showed
up as a red run. **Before trusting "this e2e spec would have caught it", run it on the
base branch.** A repo-wide sweep of the remaining six files wants its own ticket.

## A module-scope `NextResponse` can only be read once (ENG-1028, 6 Sep 2026)
`fail()` returns a `NextResponse`. Caching one 502 at module scope and returning
it from two requests works for the first caller and **500s the second** —
`Response` body/headers are single-consume. Symptom: the first Stripe-down cancel
is a clean 502, the next is an un-enveloped 500.
- **Do this:** a helper that calls `fail(...)` each time, never a reused Response.

## Worktree `next start` e2e: lockfile parent + `NEXT_PUBLIC_*` at build (ENG-1028, 6 Sep 2026)
A worktree under `.claude/worktrees/` has its own `package-lock.json` *and* a
parent one. Next 16 then infers the workspace root as the parent checkout, so
`next dev` can blow the OS file-watch limit, and `lsof` cwd on `next start` may
not equal the worktree — official `playwright.config.ts` then refuses to reuse
that server (ENG-597). Separately, `NEXT_PUBLIC_SUPABASE_*` is inlined at
**build**: a `next start` built without them hangs sign-in even if the process
env is correct.
- **Do this:** `NEXT_PUBLIC_SUPABASE_URL` + `ANON_KEY` on `npm run build`, then
  `next start --port <free>`; drive Playwright with `baseURL` only (no
  `webServer`) if ownership check fails. Do not reuse `:3000`.

## Portal tests must not pin the live `bpc_…` id (ENG-1028, 6 Sep 2026)
ENG-1023 records the sandbox Billing Portal configuration id on the Linear
ticket. Putting that id in a unit test is a real object id in git.
- **Do this:** assert pin-through with a fake (`bpc_test_pin`). Names only in
  the repo (`.env.example` already).

## Intro change-over is paid invoices, not a calendar month (ENG-1045, 6 Sep 2026)
- **Symptom:** checkout/account printed “A$19.00 from March 2027”. After cancel → gap → resubscribe that month is a lie. After `confirmPayment`, Explore showed the unpaid wall until a hard refresh — webhook had not written `active` yet.
- **Cause:** remaining intro months are discounted invoices Stripe still has to issue, not calendar months from today. `confirmPayment` only means the card was charged; `hasAccess` flips when stripe-webhook writes the row.
- **Do this:** `priceChangesOn` is always `null`. Account “Then” is `A$19.00 per month`. After pay, poll `GET /api/feed?limit=1` until 200, then `location.assign("/explore")`. 3DS `return_url` is `/explore?paid=1` and waits the same way. Timeout still navigates (fail-closed on the URL). Do not invent a change-over date from `current_period_end + remaining`.

## The marketing copy guardrail sweeps the WHOLE build — comments included (ENG-953, 4 Sep 2026)

`test/marketing-marquee.test.ts` greps `.next/{server,static}` for the
`CONFIRMATION_COPY` fragments. It is **not** scoped to `app/(marketing)/`: a
phrase from that list anywhere in the app fails the build-artifact sweep. A
forgot-password confirmation sentence tripped it.

Then the fix tripped it a second time. `.map` files are in the sweep and
sourcemaps carry **source comments**, so a comment *explaining* that the banned
wording was removed — quoting it to be helpful — fails identically.

- **Do this:** before writing any "we've sent it" confirmation copy, read
  `CONFIRMATION_COPY` in that test. Describe the banned phrases; never quote
  them, in copy or in a comment.
- The test is `it.skipIf(!existsSync('.next'))`, so it is **silent until you
  build**. `npm test` alone will not catch it — run the documented gate
  (`typecheck && lint && build && test`), and rebuild after changing copy or a
  stale `.next` will keep reporting the old result.

## Supabase password-recovery links: PKCE is the default and it breaks cross-device (ENG-953, 4 Sep 2026)

`supabaseServer()` is a `@supabase/ssr` client, which forces **PKCE**. So
`resetPasswordForEmail` mints a `pkce_` token, and the return trip carries
`?code=` — exchangeable **only** by the browser holding the
`…-code-verifier` cookie. Request the reset on a laptop, open the mail on a
phone, and the exchange fails. Worse, Supabase's `/auth/v1/verify` consumes the
emailed token *before* redirecting, so retrying in the original browser fails
too: the member is stuck in a loop of "expired" screens.

- **Do this:** the durable shape is `?token_hash=…&type=recovery`
  (`verifyOtp`, no verifier, any device). It requires the Supabase recovery
  **email template** to use `{{ .TokenHash }}` and point at the app — dashboard
  config, so a **blocking deploy step**, not a code change.
- Also dashboard config: the **redirect allow-list** must contain the
  `redirectTo` or Supabase silently substitutes the project Site URL and the
  link never reaches `/reset-password` — with every test still green. Verified
  live: a non-allow-listed value came back rewritten to the bare Site URL.
- `/reset-password` handles both shapes, and gives the PKCE-mismatch case its
  own screen — telling that member the link "expired" sends them round a loop
  that cannot succeed.

## `updateUser({ password })` needs no current password — a session is NOT authorisation (ENG-953, 4 Sep 2026)

Gating a set-new-password screen on `getUser()` returning a user turns it into a
change-password screen with no re-authentication: any live session (unattended
browser, or a stolen cookie — the `@supabase/ssr` session cookie is **not**
httpOnly) becomes a permanent takeover, and single-device login (guardrail #5)
then locks the real member out silently. Three independent reviews reproduced
this on the first draft.

- **Do this:** gate on evidence of the *recovery* specifically — an httpOnly,
  short-lived marker cookie set by the exchange handler
  (`app/reset-password/recovery-cookie.ts`), or the session's `amr` containing
  `recovery`. Never on "is someone signed in".
- Note guardrail #1 says tokens live in httpOnly cookies. **They do not** —
  `createBrowserClient` requires a JS-readable cookie and ~10 components depend
  on it. Don't write comments asserting the guardrail holds; it needs its own
  reconciliation ticket.

## A route that must not enumerate users needs a timing floor, not just a constant body (ENG-953, 4 Sep 2026)

`POST /api/auth/forgot-password` returned an identical 200 for every input and
was still a one-request oracle: `await`ing the Supabase send made a registered
address 2.5-5x slower than an unknown one, with **non-overlapping**
distributions. `curl -w '%{time_total}'` is as scriptable as reading a status.

- **Do this:** pad every response to a fixed floor (see `DEFAULT_RESPONSE_FLOOR_MS`).
  Do **not** detach the send with `after()`/`waitUntil` — the send is what writes
  the PKCE verifier cookie onto that response, and detaching silently breaks the
  `?code=` exchange.
- Read the env floor override **per call**: a module-scope `process.env` read
  happens at import, which ESM hoists above a test file's own statements, so the
  override never applies and every case waits the full floor.
- Such a route is also CSRF-able (`req.json()` ignores Content-Type, so a
  cross-site `<form enctype="text/plain">` drives it). That plants an
  attacker-known PKCE verifier in the victim's browser → login CSRF. Require
  `application/json` and reject cross-site `Sec-Fetch-Site` **before** touching
  Supabase, and still answer 200 so the guard adds no signal.
- **The test override that neutralises the floor also neutralises its tests
  (found in review, 5 Sep).** `test/forgot-password-route.test.ts` sets
  `PASSWORD_RESET_FLOOR_MS = "0"` before importing the route — correct, or its
  40-odd cases each cost 1.5s. But that made the floor unobservable to *every*
  test in the file: deleting the pad from the route left the whole suite green.
  A guardrail whose only tests run with it switched off is not pinned at all.
  **Do this:** when a suite disables a production safety via env, pin that safety
  in a SEPARATE test file that sets its own NON-ZERO value — see
  `test/forgot-password-floor.test.ts`. Then mutation-test it: delete the
  production code and confirm the new test actually goes red.
- **Do NOT reason about that split as "vitest isolates the env".** It does not.
  Vitest gives each file its own MODULE registry (so the route is re-imported and
  re-reads the value), but `process.env` is process-global and workers are reused
  across files. The invariant that actually holds is "**every** file importing
  this route sets `PASSWORD_RESET_FLOOR_MS` itself" — add a third importer that
  sets nothing and it inherits whatever ran before it, which is order-dependent
  and silent. Use `vi.stubEnv` + `vi.unstubAllEnvs` if you need one.
- **A floor must be measured on a MONOTONIC clock.** `Date.now()` truncates to
  integer ms, so two calls straddling a tick report 1ms for microseconds of real
  work and the pad lands a millisecond short — enough to make the floor's own
  test fail ~20% of the time on an idle machine (and pass under load, because
  timer overshoot hides it). It is also wall-clock: an NTP step mid-request can
  produce a huge `elapsed` that skips the pad entirely. Use `performance.now()`.

## Token-type smuggling has TWO branches to close, not one (ENG-953, 5 Sep 2026)

`/reset-password/confirm` pinned `type === "recovery"` on the `token_hash`
branch, and the `?code=` branch was left handing any PKCE code to
`exchangeCodeForSession` unchecked — so a member's own OAuth or magic-link code,
spent against that URL, bought the httpOnly recovery marker and with it the
"set a new password without knowing the old one" form.

- **Do this:** on the PKCE branch require `redirectType === "recovery"` from the
  exchange result. `resetPasswordForEmail` stores the verifier with a
  `/recovery` suffix (`getCodeChallengeAndMethod(..., isPasswordRecovery)`), and
  `_exchangeCodeForSession` splits it back off and returns it — the same signal
  auth-js uses to pick `PASSWORD_RECOVERY` over `SIGNED_IN`.
- The field is real at runtime but **absent from the published type**, so it
  needs a narrow cast. That fails closed (a missing field refuses every link),
  which is the right direction here.
- When a route grants a capability, audit **every** branch that reaches the
  grant. Fixing the branch the reviewer happened to look at is not the fix.

## A suffix match must never decide an origin (ENG-953, 5 Sep 2026)

`publicOrigin()` in the forgot-password route reached its allow-list only on the
*second* branch. The first branch — "is this a developer machine?" — returned
early with the **raw** header interpolated, so it reached neither the allow-list
nor any scheme check. It was not gated on `NODE_ENV`, so it was live in
production, and its output is the origin of a password-reset link.

- `isLocalHost` from `lib/hosts` matches the **suffixes** `.local` and
  `.localhost`. That is correct for "which URL space does this host serve", and
  catastrophic for "may this host build a URL": `attacker.com/.local` ends with
  `.local`, so it took the local branch and produced
  `http://attacker.com/.local`. `x-forwarded-proto` was copied through unread,
  so `javascript` produced a `javascript:` origin.
- **Do this:** for anything that becomes an origin, match the host **exactly**
  against a set, rebuild the value from the *normalised* host plus a separately
  validated numeric port, and choose the scheme yourself — never interpolate a
  header. Gate any developer affordance on `NODE_ENV !== "production"` **as
  well as** validating it; the gate and the validation are not substitutes.
- **The review lesson:** the first pass "confirmed" this route safe by testing
  `evil.attacker.example`, which takes the *other* branch. A test that never
  enters the vulnerable branch proves nothing about it. Enumerate the branches,
  then write a case that lands in each.

## A dev-server `.next` makes a build guard test the WRONG bundle (ENG-957, 5 Sep 2026)

`test/marketing-marquee.test.ts`'s "ships no confirmation copy in the built
output either" is gated `it.skipIf(!existsSync(REPO/.next))`. That is meant to
mean "run this where the documented `build && test` gate runs". It actually
means "run this whenever a `.next` directory exists" — and **Playwright leaves a
`next dev` build behind**. A dev bundle is unminified and carries source text
the production bundle does not, so the guard failed on a branch that had changed
nothing in marketing, purely because the e2e run happened first.

- **Symptom:** capturing screenshots (any `npx playwright test`) adds one
  marketing failure that a bare `npm test` on the same commit does not have.
  Order-dependent, and it looks like the FE change caused it.
- **Do this:** run the gate in the documented order — `rm -rf .next &&
  npm run build && npm test`. Never diff a suite result against a baseline
  unless both sides have the *same kind* of `.next` (both production, or
  neither). The like-for-like baseline is a worktree at the **same path depth**
  (see below) with the same build state.
- **Same family as ENG-991:** these marketing guards silently change behaviour
  with the environment rather than with the code. `marketing-shell` /
  `marketing-home` additionally resolve their mockup by walking up from the
  checkout, so they SKIP in a worktree outside the repo (e.g. `/tmp`) and RUN in
  one under `.claude/worktrees/`. A `/tmp` baseline therefore "passes" and
  frames the real, pre-existing red as yours. Both of those fail on an
  untouched `feature/launch-v1` when the guard actually runs — that is ENG-991's
  territory, not a regression in whatever ticket happens to notice it.

## A server component cannot CALL an export of a `"use client"` module (ENG-959)

Rendering a client component from a server component is fine; **calling a plain
function it exports is not**. It fails only at request time, with

    Attempted to call hasLinkableWebsite() from the server but
    hasLinkableWebsite is on the client.

- **Symptom:** the page 500s in the browser while `npm run typecheck` is clean
  and the jsdom unit tests pass — those tests mock the client module, so the RSC
  boundary is never exercised. Only Playwright caught it.
- **Cause:** the helper lived beside the component that used it
  (`app/(member)/trainers/[id]/website-link.tsx`), which carries `"use client"`
  for its onClick. A second, *server* caller then imported the helper from there.
- **Do this:** a pure helper shared by a client component and a server component
  belongs in a directive-free `lib/` module both sides import — not in either
  component's file, and never copy-pasted into the second caller. Pin it with a
  guard test that reads the module and asserts it has neither a `"use client"`
  directive nor any `import` (anchor the directive regex to a bare line — the
  module's own comment will quote the phrase while explaining the rule).

## A shared `*_COLUMNS` constant can change an API response from another file (ENG-959, ENG-958)

`HORSE_PROFILE_COLUMNS` (`lib/horse/profile.ts`) has **two** consumers: the horse
profile page and `app/api/horses/[id]/route.ts`. The route returns the embedded
`trainer` object **verbatim**, so any field added to `trainer:trainer_id(...)` is
silently published in that route's JSON — a contract change made by editing a
different file, with nothing in front of it.

Two tickets hit this in the same week, from different angles:

- **ENG-959** wanted `trainer.website_url` for a shares CTA on ONE screen, and
  did NOT widen the embed — that screen reads the column itself.
- **ENG-958** needed `trainer.photo_url` on the profile page and DID widen it,
  which put a bare private-bucket **object path** into the BFF envelope — the
  exact thing `lib/storage/photos.ts` exists to prevent. The suite stayed green,
  because `test/horses-route.test.ts` asserted only TOP-LEVEL envelope keys.

**Do this:** before widening a shared projection, `grep` every consumer and check
what each one *returns*, not just what it reads. A column ONE screen needs should
be read by that screen. Adding a column the route field-picks (a `horse` column)
is safe; adding one it passes through is not — and if you must, strip or sign it
in the envelope and pin the object's key set with a **literal** assertion. A test
that compares against the re-imported constant guards nothing: widening the
constant widens the assertion with it, and the guard passes on any value.

## `horse_training_status_check` now admits only six values (ENG-959)

The 1 Sep 2026 migration merged the legacy training-yard spellings. Locally the
constraint is `spelling | breaking_in | pre_training | in_training | racing |
retired`, so **seeding `farm_training`/`city_training` in an e2e fails with
23514**. Cover the legacy collapse at unit level, where the value can still
exist, and keep those switch cases in production code for clients rendering a
cached pre-migration row.

## `text-overflow: ellipsis` does NOTHING on an `inline-flex` pill (ENG-958, 5 Sep 2026)

**Symptom:** `.post-badge` was given `max-width` + `overflow:hidden` +
`white-space:nowrap` + `text-overflow:ellipsis`, and a long label still clipped
**mid-word with no ellipsis** — which reads as deliberate, so it survived review,
six passing e2e tests and a committed screenshot.

**Cause:** `.post-badge` is `display: inline-flex` (it needs the flex row for its
`::before` dot). `text-overflow` only applies to a **block container that
directly holds the overflowing inline content**; inside a flex container the copy
becomes an *anonymous flex item* and the ellipsis is never drawn.

**Do this:** put the copy in its own child (`.post-badge-text`) and move
`overflow/white-space/text-overflow/min-width:0` onto **that**, leaving only
`max-width:100%; min-width:0; overflow:hidden` on the pill. This is what mobile
already does — its pill is a `View` whose copy is a `<Text numberOfLines={1}>`
child. `.reel-head .reel-horse` was already the correct idiom in this file.

**And pin it with a fixture that actually overflows.** Every labelled fixture in
`app/preview/components/page.tsx` was short enough to fit the column, so nothing
could catch this. A truncation guard that never truncates passes vacuously — the
e2e now asserts `scrollWidth > clientWidth` FIRST, then the ellipsis.

## `getComputedStyle().borderRadius` returns a PERCENTAGE verbatim (ENG-958)

Asserting a circle by resolving `50%` against the box (`parseFloat(radius) ≈
width/2`) FAILS: Chrome reports the literal `"50%"`, so `parseFloat` yields 50 and
a 28px box compares against 14. Compare the **token** (`toBe("50%")` for the
circle, `toBe("14px")` for the box) — the two are distinguishable precisely
because one is a percentage and the other is not.

## The preview gallery's fixtures are SHARED — a new one can break a sibling's test (ENG-958)

`e2e/eng-613-*` locates the stable-update card by the phrase `"Quiet week here"`.
A new ENG-958 update fixture that reused that opening made the locator match two
cards and fail as a Playwright strict-mode violation — a red spec in a file the
diff never touched. Same class: an unscoped `filter({ hasText: "Winx" })` matches
this round's card *and* the round-5 card it was spread from.
**Do this:** give a new fixture distinctive copy, and scope every locator in a new
spec to that round's own `data-testid` section.

## Recurring — grill-time prevention

### Never claim a mutation test you did not run (ENG-1016, 5–6 Sep 2026)

A PR body asserts *"revert X → N tests fail"*, the reviewer reads the table, believes the guard is
pinned, and approves. The guard is not pinned. This class landed **eight verified times across the
four repos on 5–6 Sep 2026 alone** — every one re-checked in-repo while writing this, not taken on
report. Four of the five originally recorded here were caught by the author's own fresh-eyes pass and
fixed inside the same PR; all eight are fixed at `feature/launch-v1` today, so the merged state is
clean — but every one of them was *written down as run* before it was run. That is the failure being
recorded here.

Count with care: an earlier draft of this entry said *five*, having stopped counting at the instances
that fit the two shapes it had named. The number was not wrong because someone miscounted — it was
wrong because the taxonomy below was treated as the boundary of the class.

**1. Never write a mutation-test table from reasoning.** Run `delete → test → restore → test` and
paste both counts. If you did not run it, do not claim it. admin #78 (ENG-950) claimed *"remove
`.in("status", ...)` → race test fails (`expected 200 to be 409`)"*. Deleting
`.in("status", ["draft","scheduled"])` from the route actually left the publish suite **12/12
green** — `supabase-fake`'s `in` was a no-op. The claim only became true at commit `32117af`, and
the PR body now says so in exactly those words.

**2. Reviewer's rule: re-checking a corrected claim means re-RUNNING the mutation, not re-reading
the prose.** The prose was confidently wrong the first time. mobile #112 (ENG-954) is the case: the
original claim was, in the author's own words, "honest but coarse" — every existing test reached
`stripUrlQuery` through `redactText`, which percent-decodes **first**, so the `%3F|%23` alternation
was pinned by nothing and deleting it left **37/37 green**. No amount of re-reading that sentence
would have surfaced it; running it did. The fix was a `describe` block calling `stripUrlQuery`
directly.

**3. Apply the mutation, then `git diff` to confirm you changed the line you meant** — before you
believe a green result. A mutation that silently no-ops is indistinguishable from an un-pinned
guard, and it lies in *both* directions: it makes a real guard look vacuous as easily as it lets a
vacuous one look pinned. Prefer a **python exact-match edit** over `perl -0pi -e 's/…/…/'`: an
escaped-regex payload silently substitutes nothing, and a non-global substitution hits the **first**
match, which is usually a doc comment rather than the code. That bit the integrate loop twice in one
day, in opposite directions.

**4. Two fixture smells that make an assertion vacuous.**

- **A seed that already satisfies the assertion in both directions.** admin #84 (ENG-963) seeded
  `[t1 (2 horses), t2 (1 horse)]` and asserted `horses desc === ["t1","t2"]` — which is just the
  fetch order, so deleting `sortTrainerRows` outright left the suite green. The fix reorders the
  seed so that **no** asserted order equals it; the merged test carries a `SEED ORDER IS
  LOAD-BEARING` comment explaining why. (The suite here is 1321 tests / 75 files — if you are
  quoting a count, re-measure it rather than copying one from another PR body.)
- **`toContainEqual`/`toContain` where `toEqual`/`toBe` is meant.** A containment matcher passes on a
  **superset** — i.e. on the leak itself. admin #79 (ENG-993) pinned a filter-leak test with
  `expect(second.filters).toContainEqual({ column: "archived_at", value: null, op: "is" })` in
  commit `c3d075d`: that passes on an array that has picked up extra entries, which is precisely the
  bug the test was written to catch. Replaced with `expect(first.filters).toEqual([...])` in
  `af4c5e8`.

**5. Pin with literals, not by re-importing the constant under test.**
`expect(x).toBe(IMPORTED_CONST)` is vacuous *with respect to that constant's content*: widening the
constant widens the assertion along with it. The cleanest contrast is two PRs in the same repo,
days apart:

- **web #90 (ENG-958) — wrong.** `test/horses-route.test.ts` imports `HORSE_PROFILE_COLUMNS` and
  asserts `expect(horseSelectMock).toHaveBeenCalledWith(HORSE_PROFILE_COLUMNS)` — the same constant
  the route uses to build its own `.select()`. The advertised `photo_url` strip therefore survives
  deletion with the suite green **and** `tsc` clean.
- **web #91 — right.** `test/horse-status-scale.test.tsx` treats the constant as the *subject* and
  pins it with literals: `expect(HORSE_PROFILE_COLUMNS).toContain("shares_for_sale")` and
  `expect(trainerEmbed).not.toContain("website_url")`.

**6. The assertion's subject is source text, not behaviour.** admin #83 (ENG-984), at
`7a65b97:lib/analytics/reset.test.ts:108`:

```js
it("still defaults to a dry run and only deletes behind --confirm", () => {
  // Cheap textual guard on the two properties that make this script safe.
  expect(cliSource).toMatch(/argv\.includes\("--confirm"\)/);
  expect(cliSource).toMatch(/Dry run — no rows deleted\./);
});
```

`cliSource` is a `readFileSync` of the script (declared at `:82`), so the body greps a file instead
of running it. **This survived deleting both safety gates of a script that wipes four production
tables** — the highest-severity instance in the set. The signature worth learning: **a test title
naming runtime behaviour over a body that greps source.** Fixed at base by a real behavioural gate,
`reset CLI — GATE B: dry run is the default`, which asserts on the rows actually deleted.

**7. The harness supplies the thing the claim attributes to production code.** admin #85 (ENG-964),
at `4f2e75f:app/(dash)/posts/PostActions.test.tsx:190`:

```jsx
// ...and the layout mounts the single region alongside them.
render(<ToastRegion />);
```

The comment credits `layout.tsx`; the line directly under it mounts the region **in the harness**.
Every other toast test mounted it the same way, so nothing pinned the layout's own mount and
deleting `<ToastRegion />` from `layout.tsx` left the suite green. Fixed at base twice over: the
comment now states exactly what the harness does and does not prove, and `app/(dash)/layout.test.tsx`
pins the layout mount for real, mutation-proven.

**The shapes seen so far — an open list, not a checklist.** Do **not** stop looking when an instance
matches none of these; an incomplete taxonomy asserted as complete is worse than none, because it
tells you when to stop:

- **a fixture that satisfies the assertion either way** — ENG-963 (pre-sorted seed), ENG-954
  (assertion routed through a decoder), ENG-993 (containment matcher);
- **a mock that discards the thing being asserted** — ENG-950 (`supabase-fake`'s `in` was a no-op),
  ENG-958 (the projection pinned against its own imported constant);
- **an assertion whose subject is source text, not behaviour** — ENG-984 (6 above);
- **a harness that supplies the thing the claim attributes to production code** — ENG-964 (7 above);
  and
- **a wait that resolves on a weaker proxy than the precondition it stands for** — ENG-1024, where
  `findByTestId("photo-crop-dialog")` proves only that the dialog MOUNTED, never that it is USABLE,
  so the click that followed took `apply()`'s `if (!loaded) applyAsIs()` path and `cropToBlob` never
  ran at all.

ENG-993 fixed the *mechanism* behind the second shape in `supabase-fake` (8 query methods that
silently no-opped). Nothing prevents any of these from being **claimed** without being run — which
is what this entry exists to prevent.
## Client `/api/*` calls go through `apiFetch`, not bare `fetch` (ENG-961)
`lib/api/client.ts` wraps `fetch` and centrally handles a 401 from a member BFF
call (single-device eviction → clear session → `/signin?reason=signed-out-elsewhere`).
Any NEW client-side `/api/*` call should use `apiFetch` or it silently opts out of
eviction handling. Two call sites deliberately stay on bare `fetch`:
`app/start/trial-start-form.tsx` and `app/forgot-password/forgot-password-form.tsx`
— they are the SIGNED-OUT flows, and `/api/auth/*` is excluded by the wrapper too.

**Do not widen the trigger to 402.** `GATED()` is a lapsed *subscription*, not a dead
session (guardrail 3); signing those members out strands them with no way to reactivate.
Every 401 under `app/api/*` is `UNAUTH()` behind an `if (!user)` guard — there is no
route that 401s for a non-session reason, which is what makes the status a safe signal.

## A `fetch` wrapper must forward the ORIGINAL argument shape
`apiFetch(input, init)` calling `fetch(input, init)` with `init === undefined` passes a
SECOND argument, and `fetch.mock.calls` then records `[url, undefined]`. That broke
`test/post-media-client.test.ts`, which asserts `toHaveBeenCalledWith(url)` exactly.
Branch on `init === undefined` and call `fetch(input)` — a drop-in wrapper has to be
indistinguishable from `fetch` at the call site.

## Member nav is plain `<a>`, so EVERY *shell* screen change is a full page load (ENG-961)
`app/(member)/sidebar.tsx` renders `<a href>`, not `next/link`. So every hop taken
through the sidebar — Explore -> Saved -> a profile — tears down the document and
the JS heap, and the destination screen re-runs its server component and re-fetches
from scratch.

**One carve-out, and it is not "anywhere in the member shell":** `next/link` is
imported in exactly one member file, `app/(member)/shares/shares-list.tsx:23`, used
at `:281` for the row link to a horse profile. That hop IS a client-side transition
and the module heap DOES survive it. It changes nothing about bookmarks (`/shares`
holds no bookmark state), but do not restate the absolute — check with
`grep -rn "next/link" "app/(member)"` before relying on "no client transitions
exist", because an over-broad absolute here is how the next wrong conclusion gets
built.

Two consequences worth knowing before building anything "cross-screen":

1. **A module-level store/bus/cache CANNOT carry state between member screens.**
   It does not survive the reload. ENG-961 originally ported mobile's
   `subscribeBookmarkChanges` bus for cross-surface bookmark sync; it was inert on
   web and was removed before merge. The mobile precedent transfers badly because
   React Navigation keeps sibling tab screens MOUNTED, so a module-level Set
   reaches them — App Router with plain anchors never does. The five screens
   holding their own `bookmarked` (explore-feed, following-screen, saved-feed,
   trainers/[id]/trainer-posts, horses/[id]/horse-posts) are never co-mounted:
   one feed per route, no parallel/intercepting routes.

2. **"Screen A does not reflect a change made on screen B" is usually NOT a bug
   here** — each screen re-reads its own `bookmark`/`reaction`/`follow` rows on
   mount, so the reload already shows fresh state. Reproduce such a report against
   the running app before building a sync mechanism for it.
   `e2e/eng-961-bookmark-journey.spec.ts` pins the real behaviour end to end
   (save on a horse profile -> sidebar link -> the card is on /saved).

If the shell moves to `next/link` more broadly, both points flip — revisit anything
that relies on the reload.

## An auth-provider outage can sign EVERY member out at once (ENG-961, residual)
The 401 eviction in `lib/api/client.ts` trusts `UNAUTH()`, and every `app/api/*`
route emits `UNAUTH()` from a bare `if (!user)` — **discarding the `getUser()`
error**. A transient GoTrue outage therefore nulls `user` for everyone at the same
time, so every logged-in member gets a 401 they did not earn, is signed out, and is
told their account was used on another device. This is a real storm, not a
hypothetical, and it belongs next to the trigger rules rather than only in a PR
description.

What keeps it survivable today: `signOut({ scope: "local" })` clears only the
browser that saw the 401, so members simply sign back in — `scope: "global"` would
have revoked their sessions on every device from one spurious 401, which is not
recoverable by the member. Keep the scope local.

The proper fix is upstream and not in this ticket: distinguish "no session" from
"could not reach the auth provider" in the route guards and emit a 5xx for the
latter, so the client never reads an outage as an eviction. Do that before widening
the eviction trigger any further.

## The web onboarding mockup is horses-only "Step 1 of 2" — there is no trainer step
`06-stage1-design/mockups/web/screens/05-onboarding.html` has ONE step (pick horses,
"2 minimum to continue") and no trainer picker; `_archive/` has no onboarding variant.
Mobile onboarding is trainers → horses → notifications, so any "web onboarding parity"
ticket that asks for a trainer step has **no backing design** and is `needs-spec` per the
guardrail, not `ready`. Note also that the "Step 1 of 2" copy in `horse-picker.tsx` is
aspirational — no step 2 screen or step routing exists in code.
## A "remove one `.eq()`" ticket is usually THREE coupled sites, not one line
ENG-960 (R8 shares reversal) named three files, each as a single line. Two were
one line; `app/(member)/trainers/trainers-grid.tsx` was **four coupled sites**:
the `TrainerRow` type, the explanatory comment, `shares_for_sale` inside the
embedded `horses:horse!trainer_id(...)` projection, AND the client-side
`horseCount` filter. Deleting only the projection column leaves the card
reading **"0 horses"** for a for-sale-only stable while the roster one click
away (fixed in `trainers/[id]/page.tsx`) lists three — the list looks fixed and
the count silently still lies. Grep the whole file for the flag, not the one
line the ticket cites, and pin the rendered COUNT in a test, not just the query.

## Reversal tickets have a SECOND lock: the source-grep guard test
`test/shares-segregation-guard.test.ts` asserts the exclusions **exist in
source**. Removing them turns it red in a file no ticket lists in its surface.
Any ticket reversing a documented rule must budget for inverting its guard.
Two traps when you do:
- The guard greps raw source, and your new code explains the removal in a
  COMMENT that names the flag — so `expect(src).not.toMatch(/shares_for_sale/)`
  fails on your own prose. Strip comments before matching (the file already has
  a `strip()` helper for exactly this).
- Invert it with a **positive anchor** (`.from("horse")`, `.eq("status",
  "active")`) beside every negative one, or a file that failed to load passes
  every `not.toMatch` vacuously — the false-green class this file already records.

## `.rx/review/` PNGs: check the ticket's own e2e spec exists before assuming no harness
The harness needs NO `.env.playwright` — `playwright.config.ts` passes the
well-known local Supabase demo keys itself. It DOES need local Supabase already
up (`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:54321/rest/v1/`
returns 200 when it is). That one curl is the whole pre-flight.

## Web browse grids read UNBOUNDED until ENG-960
`horses-grid.tsx` / `trainers-grid.tsx` had no `.limit()` at all, while mobile
has capped every browse read at `BROWSE_PAGE_SIZE = 100` since ENG-424 and
ENG-956's `shares-list.tsx` had already mirrored it as `SHARES_PAGE_SIZE = 100`.
ENG-960 added `lib/browse.ts` (`BROWSE_PAGE_SIZE = 100`) for the two grids.
The 60-item "Show more" PAGER originated in web PR #81 (`perf/query-batch`),
which targets `main`, not `feature/launch-v1`. **That is no longer the state of
this branch.** An earlier revision of ENG-960 shipped the cap with no pager,
making row 101 unreachable; Naufal rejected it (6 Sep 2026) — nothing may be
truncated — and ENG-960 then lifted the mechanism into `lib/browse.ts` for both
grids. So on `feature/launch-v1` **every row is reachable via "Show more"**:
neither grid carries a `.limit()`; both page with `.range()`. (Stated that way
deliberately — reading only the merged branch you will find no `.limit()`
anywhere, so "replaces `.limit()`" describes a moment, not the tree.)

Two things to carry rather than re-derive. `splitBrowsePage()` over-fetches ONE
probe row (`BROWSE_FETCH_LIMIT = BROWSE_PAGE_SIZE + 1`) and answers
`hasMore: rows.length > BROWSE_PAGE_SIZE` — **not** `=== BROWSE_PAGE_SIZE`, which
is the off-by-one PR #81 still carries and which offers "Show more" with nothing
behind it when the total is an exact multiple of the page size. And the next
offset is the RENDERED count, not the fetched count, so the probe row leaves no
gap. Reuse `lib/browse.ts`; do not write a third copy of this.

## A test can "pin" an invariant it never touches — check the fixture, not the title
ENG-960 shipped a test titled *"INVARIANT: the pager can never outlive its
roster"* whose comment said hoisting the Show-more button out of the
`horses.length > 0` render gate would red it. It did not: the fixture supplied
ZERO rows, so `splitBrowsePage` returned `hasMore: false` and the inner
`{hasMore && (<button>)}` satisfied "no Show more" on its own, whatever the
outer gate said. Deleting `horses.length > 0` left the whole 1367-test suite
green. Renaming the test moved the false claim; it did not repair it.

The shape to watch for: **an assertion satisfied by an inner guard tells you
nothing about the outer one.** A negative assertion ("X is absent") is
especially prone to this — absence is over-determined, so any one of several
guards can produce it while the test appears to name a specific one. Fixing it
meant asserting the gate's OWN effect (with no rows the `.onboarding-grid-web`
container does not render at all), which is not reachable via `hasMore`.

Corollary, learned the same day on the same file: **union protects the append;
it does not keep the content true.** `.rx/gotchas.md` is `merge=union`, so a
paragraph that was true when written lands verbatim on the launch branch long
after it went stale. When you touch this file, re-read the paragraphs AROUND
your edit and check they are still true of the merged tree — do not only append.

## A shared helper introduced by an OPEN PR is not on your base (ENG-1038, 6 Sep 2026)

**Symptom.** The ticket says "reuse `lib/browse.ts` — `splitBrowsePage()` / `browseRange()`, do not
re-derive". You branch off `origin/feature/launch-v1`, import it, and the module does not exist.

**Cause.** ENG-960 *extracted* those helpers, and ENG-960 is **PR #104, still open**. A worktree
branched off the integration branch sees only **merged** work. This is the same blindness the
migration-numbering note describes, one level up: it applies to any file an in-flight PR introduces,
not just migrations.

**Do this.** Do **not** re-cut the helper under a new name — that is how a codebase ends up with
three paging variants that silently disagree on an off-by-one. Carry the file **byte-identical** from
the open PR's branch and verify it:

```bash
git checkout origin/<their-branch> -- lib/browse.ts
diff <(git show origin/<their-branch>:lib/browse.ts) lib/browse.ts && echo identical
```

An add/add merge of identical content resolves cleanly, so whoever merges second gets a no-op. Make
**zero** edits to the carried file (an edit turns the clean add/add into a real conflict), say so in
the PR body, and state that if their PR changes the file during review, theirs wins wholesale.

**Note the second half of the mechanism may NOT be shared.** #104 shared the paging *arithmetic* but
left the Show-more *button* copy-pasted between two grids with inline styles, and its `.btn-showmore`
class lives in `app/globals.css` — also that PR's surface. Style a third surface's pager from its own
CSS module rather than depending on a global class that is not on your base, or it ships unstyled.

## The marketing site is noindex site-wide — "make this page indexable" is a 3-surface job (ENG-1041, 6 Sep 2026)

`MARKETING_IS_INDEXABLE` in `lib/seo.ts` is `false` and **three** surfaces read it:
`app/robots.ts`, `middleware.ts`'s `X-Robots-Tag`, and `app/(marketing)/layout.tsx`'s
meta tag. A ticket that says "must not be noindexed" is therefore never a one-line
metadata change, and it is never a reason to flip the flag — the flag is false
because 19 real trainers are photographed beside placeholder biography.

- **Do this:** carve out a PATH allowlist (`ALWAYS_INDEXABLE_PATHS`) read by all
  three, not a flag flip. Scope it to the marketing host so the member space stays
  noindex unconditionally, and test both directions — the exempt path AND that its
  neighbours, near-miss paths and the app host are unchanged.
- **`Disallow: /` in robots.txt beats a page's `index` meta tag**, because a crawler
  that may not fetch the page never reads the tag. The `Allow:` line is mandatory,
  not belt-and-braces. Next emits all `Allow:` before all `Disallow:`, and longest
  match wins.
- **Two different match semantics, easy to miss:** `Allow:` in robots.txt is a
  PREFIX rule; an `includes()` allowlist is EXACT. robots.txt therefore already
  permits crawling any future child route under an allowlisted path.
- **`follow` is not symmetric with `index`.** `Disallow: /` stops crawlers FETCHING
  the rest of the site; it does not stop them INDEXING a URL discovered as a link.
  One indexable page inside a shared shell links `/start`, `/signin` and every other
  legal route from its nav and footer. Use `follow: false` unless link discovery is
  actually wanted.

## A `force-static` page cannot have host-aware metadata — say so before claiming it does (ENG-1041)

`/legal/*` renders on BOTH hosts from ONE prerendered HTML file. So a page-level
`robots: { index: true }` says `index` on `app.stablepass.co` too, and no
`generateMetadata` can prevent that — it has no request to read. The member space
stays noindex only because the two HOST-AWARE surfaces (the `X-Robots-Tag` header
and that host's `Disallow: /`) also apply, and Google resolves a meta-vs-header
conflict to the most restrictive.
- **Do this:** don't write "marketing space only" over all three surfaces; it is
  true of two. Say which surface is unconditional and warn against "fixing" the
  apparent disagreement by dropping a backstop. A reviewer WILL find this.

## Adding a legal page: `content/legal/*.md` + a slug, but the parser has no inline links (ENG-1041)

Adding a document to `/legal/[slug]` is three edits — a slug in `LEGAL_DOCUMENT_SLUGS`,
a `content/legal/<slug>.md` with `title`/`lastUpdated` frontmatter, and a footer entry.
But `lib/legal.ts`'s markdown subset deliberately does NOT interpret inline markup, so
a document on the generic route can PRINT an address and cannot offer a working
`mailto:`. A page that needs a live link, or its own `robots`, needs its own route.
- **Keep a standalone slug OUT of `LEGAL_SLUGS`** (`LEGAL_STANDALONE_SLUGS` exists for
  this). That constant drives `[slug]`'s `generateStaticParams`, so listing it there
  makes two routes claim one path: the static segment wins and the prerender is dead
  weight nobody can see is dead.
- **Lift the whole document SHELL, not just the block renderer.** ENG-1041 first
  shared only `<Block>` and still wrote the `<main>`/`.wrap`/`<article>` frame, kicker,
  `<h1>` and "Last updated" line out twice — which is the part that actually drifts.
  `legal-document.tsx` now owns the frame; `children` is the one seam.

## The footer's Legal column is pinned in THREE places, exactly (ENG-1041)

Adding a fifth link reds `test/marketing-shell.test.tsx`, `test/marketing-sheets.test.tsx`
and `e2e/marketing-interactive.spec.ts`. Two are exact-list `toEqual` assertions.
- **Do this:** update all three and keep them EXACT — do not relax to `toContain`. The
  footer is the only discovery path for a page like the deletion route, so a silent
  drop must red. `legal.module.css` is NOT covered by the ENG-991 marketing.css guard
  (that guard diffs `marketing.css` against the mockup), so page-specific rules belong
  there — but use the sheet's real tokens (`--line`, the 12/16/20/22/26/32 radius
  ladder, the ported `.eyebrow`) rather than inventing values. A one-off `color-mix()`
  or a `10px` radius is exactly what a fidelity reviewer catches.

## Adding a public page? Add it to `e2e/legal.spec.ts`'s DOCUMENTS loop (ENG-1041)

A unit test that imports and renders a page component proves the component renders.
It does NOT prove the ROUTE resolves 200, that the canonical is emitted into the DOM,
or that the page reads with scripting off (an explicit client requirement here). For a
page whose entire purpose is "a store reviewer can open this URL", that gap matters.
The `DOCUMENTS` loop in `e2e/legal.spec.ts` gives all of it for one array entry —
but its ALIASES loop hardcodes an `<h1>` of "Terms & Conditions", so only join
`DOCUMENTS`.

## Playwright's Chromium PLAYS HLS — it cannot prove an hls.js fix (ENG-1056, 10 Sep 2026)

`components/media-player.tsx` handed a Mux `.m3u8?token=` URL to a bare `<video src>` for
months and every Playwright run was green, because Playwright's bundled Chromium reports
`canPlayType("application/vnd.apple.mpegurl") === "maybe"` and genuinely plays HLS (its
build enables the built-in HLS player). Real desktop Chrome, Firefox and Edge report `""`
and fail the element with `MediaError code 4 "Failed to open media"` — which, with no
`onError` on the element, was a black box and a spinner forever.
- **Do this:** for anything HLS, drive the automated negative in **Playwright Firefox**
  (`npx playwright install firefox`; `test.use({ browserName: "firefox" })` at the TOP
  level of the spec — `test.use` is rejected inside a `describe`). Firefox is the honest
  browser here: `canPlayType(HLS)` is `""`, so it exercises the hls.js path and the error
  path the way a member's browser does. Keep real Chrome/Safari as a manual acceptance
  step and say so in the PR.
- The same trap in reverse: asserting "the video element exists" proves nothing about
  playback. Assert the transport — that `loadSource` got the minted URL, or that a dead
  stream produces the honest error pill rather than an empty `<video>`.

## `.rx/mockups.md`'s `06-stage1-design/` path does not exist here (ENG-1056, 10 Sep 2026)

Re-checked 10 Sep 2026 from a worktree: `<workspace>/06-stage1-design/` is absent, and the
readable mockups are back under `<workspace>/dev-handover/StablePass-mockups/mockups/web/screens/`
(`06-explore.html`, `07-horse-profile.html` both open). This entry has now flipped three
times in this file. **Do this:** never trust either path from memory — `ls` both before
building, and cite the one that actually resolved in the ticket you write.

## `components/media-player.tsx` is NOT what member feeds render (ENG-1056, 10 Sep 2026)

`MediaPlayer` is mounted in exactly ONE place — `app/preview/components/page.tsx`, the
unlinked no-auth dev gallery. Every real member feed inlines its **own**
`<video controls autoPlay src={playbackUrl} />` plus its own private
`async function play(postId)` that mints with a **GET** (`apiFetch(url)`, no `method`):
`app/(member)/explore/explore-feed.tsx`, `following/following-screen.tsx`,
`saved/saved-feed.tsx`, `horses/[id]/horse-posts.tsx`, `trainers/[id]/trainer-posts.tsx`.
`PostCard` only draws the `.media-play` button and calls back through its `onPlay` prop.
ENG-1056 was grilled on the belief that fixing `MediaPlayer` fixes members; it does not.
- **Do this:** before ticketing or "fixing" a shared component, `grep -rn "<ComponentName"`
  for its real mount sites. Five near-identical copies of the mint-and-play block is the
  actual shape of this code, and any player change has to land in all five at once or they
  desync. `MediaPlayer` is effectively gallery-only until they are consolidated.

## An e2e that renders a member SCREEN must promote the seeded subscription (ENG-1056)

`auth.admin.createUser` fires a trigger that provisions a `trial` subscription, and ENG-999
retired `trial` — `lib/api/access.ts` no longer grants it. So a freshly-created e2e user hits
the `AccessWall` and every profile/browse screen renders **zero cards**, which reads exactly
like "the feature is broken" and makes card assertions fail for the wrong reason.
- **Do this:** after `createUser`, `update({ status: "active", current_period_end: <future> })`
  on `subscription` for that `user_id`. Specs written before ENG-999 (e.g.
  `e2e/video-poster.spec.ts`) do not do this and cannot render a card any more.

## Proving hls.js is the TRANSPORT: filter the manifest request by resourceType (ENG-1056)

Asserting "the `.m3u8` was requested" proves nothing — a bare `<video src>` requests the
manifest too. Chunk FILENAMES are opaque hashes in a Next build, so matching `/hls/` in a URL
finds nothing either (this cost a debug cycle). What works: `page.on("request")` and keep only
manifest requests whose `req.resourceType()` is `xhr`/`fetch`. hls.js uses XHR; the media
element uses `media`/`other`. Pair it with a first test that asserts
`canPlayType("application/vnd.apple.mpegurl") === ""` in the browser under test, so the file
fails loudly if it ever stops running in Firefox instead of silently proving nothing.

## A seeded e2e member is LAPSED by default — entitle them explicitly (ENG-1057, 10 Sep 2026)
**Symptom:** a new Playwright spec signs in a freshly-created member, navigates to a gated
member screen, and every assertion fails on an element that was never rendered — the screen is
the AccessWall. It reads like a bug in the feature under test.
**Cause:** the `auth.users` trigger inserts a `subscription` row at the column DEFAULT, which is
`lapsed`. ENG-999 retired the free trial, so `has_content_access` grants only on `active`
(within its 3-day renewal grace) or an unexpired `canceled` — `trial` is no longer entitled.
Several older specs carry a comment claiming "the createUser trigger provisions the trial
subscription the browse gate reads"; that comment predates ENG-999 and is now wrong.
**Do this:** after `auth.admin.createUser`, explicitly
`update subscription set status='active', current_period_end='2099-01-01' where user_id=...`.
This also matters for Storage: the policy `media gated read` is `authenticated AND
has_content_access`, so an unentitled member signs nothing and every photo silently falls back
to initials — a weaker test passing for the wrong reason.

## A supabase mock without `storage.from` throws once a screen signs photos (ENG-1057)
**Symptom:** unrelated component tests start failing with `sb.storage is undefined` after a
screen adds a `signPhotoMap`/`signPhoto` call.
**Cause:** the common mock is `supabaseBrowser: () => ({ from: fromMock })` — no `storage`.
**Do this:** add a `storage: { from: vi.fn((bucket) => ({ createSignedUrls: async (paths) => ({
data: paths.map((p) => ({ path: p, signedUrl: `https://.../${bucket}/${p}` })), error: null }) })) }`
shim. Make it a `vi.fn()`, not a bare object — the guardrail test "a walled member makes ZERO
Storage calls" needs it to be spyable. Note `createSignedUrl` (singular) and `createSignedUrls`
(plural) are different methods; a page using `signPhoto` needs the singular one.

## `.select()` projections are invisible to tsc — pin them LITERALLY or they rot (ENG-1057)
**Symptom:** deleting a column from a `.select(...)` string leaves the whole suite green and
`tsc --noEmit` clean, and the feature silently reverts in production.
**Cause:** `sb` is untyped, and the common `chainable()` test helper makes `select` a
`vi.fn(() => obj)` that IGNORES its argument and returns fixtures which carry the column anyway.
**Do this:** every changed projection needs an `expect(chain.select).toHaveBeenCalledWith("<the
exact string>")`. Prove each pin is non-vacuous the same way: delete the column from the source,
confirm that ONE test reds, restore. A mock shim alone is not coverage.

## Screenshotting /explore on the DEV server catches a StrictMode feed flash (ENG-1057)
**Symptom:** a Playwright screenshot of `/explore` shows "Couldn't load the feed." beside a
perfectly correct aside, and it looks like the diff broke the feed.
**Cause:** React StrictMode double-invokes effects in dev, so the feed's two passes race and the
error state flips in and out for the first seconds. It reproduces identically on the base branch.
**Do this:** don't try to wait it out — asserting the text has cleared passes and then the text
returns on the next pass. Screenshot the surface you actually changed and say so in the PR. If
you suspect a real regression, A/B it: revert just the one file, re-run the same seeded probe.

## A worktree resolves `node_modules` from the SHARED checkout — which is on `main` (ENG-1059, 11 Sep 2026)

**Symptom.** You branch a worktree off `origin/feature/web-media-v1`, which has `hls.js` in its
`package.json` since ENG-1056, and every gate dies at
`Failed to resolve import "hls.js" from "components/hls-video.tsx"` — vitest, `tsc` AND `next build`.
M1's own untouched `test/media-player.test.tsx` fails identically, which makes it look like M1
shipped broken.

**Cause.** `.claude/worktrees/<ticket>/node_modules` starts EMPTY, and Node's directory-walk
resolution then climbs to `<repo>/node_modules` — the shared checkout's, which sits on whatever
branch the human left it on (usually `main`). So a worktree silently builds against the DEPENDENCY
SET OF A DIFFERENT BRANCH. Any dependency a blocking ticket added is invisible, and the failure names
the *consumer* file, never the missing install.

**Do this.** Run `npm ci` in the worktree before the first gate. Use `ci`, not `install` — it
installs from the lockfile and leaves `package.json`/`package-lock.json` untouched, which matters
when both are on the ticket's do-NOT-touch list. It takes ~10s. Corollary: do not "baseline" such a
failure in a throwaway worktree created OUTSIDE the repo tree — resolution cannot find `vitest` there
either, and you will confirm the wrong thing. Baseline inside `.claude/worktrees/` (same depth), and
symlink the populated `node_modules` in.

## `e2e/video-poster.spec.ts` is PRE-EXISTING RED, and it fails BEFORE its real assertion (ENG-1059)

It dies at `page.getByLabel("Password")` — ambiguous since the reveal toggle
(`<button aria-label="Show password">`) landed, the trap this file already documents twice. It
therefore never reaches its poster assertions, so **"a video post with a baked poster renders the
frame" is currently an UNPROVEN claim on this branch**, not a passing guard. Observed alongside it:
a freshly seeded video post renders the dark empty box at idle, with no poster `<img>` at all.
- **Do this:** do not cite that spec as evidence the poster seam works, and do not import its red
  into an unrelated ticket by asserting a visible poster `<img>`. Anchor sign-in on
  `page.locator("input[type=password]")` in any new spec.

## A source-grep guard reds on the COMMENT that explains the thing it forbids (ENG-1059, recurring)

Third sighting of this class (ENG-960's `shares_for_sale`, ENG-1041, now here). ENG-1059's guard
asserts no `autoPlay` under `app/(member)/**`; the swap that removes `autoPlay` explains itself with
`// Deliberately NO \`autoPlay\`: HlsVideo calls play() itself` — so the change reds its own guard.
- **Do this:** strip comments before matching, and keep a POSITIVE anchor (here: the `HlsVideo`
  import) asserted against the SAME stripped string, or a file that failed to load satisfies every
  `not.toContain` vacuously.
- **The house `strip()` is not string-literal aware.** `.replace(/\/\/.*$/gm, "")` also blanks a line
  from the `//` inside `https://…` onward, so a forbidden token later on that line escapes.
  `/(^|[^:])\/\/.*$/gm` → `"$1"` keeps URLs whole. The copies in
  `test/shares-segregation-guard.test.ts` and `test/media-player.test.tsx` still carry the naive form.

## The pill a feed shows on a video failure is a SIBLING of `.post-web`, not inside it (ENG-1059)

All five member feeds render `<div key={p.id}><PostCard/>{playError && <p role="alert">…}</div>`, so
`page.locator(".post-web").screenshot()` — the framing every existing spec uses — CROPS THE PILL OUT.
A screenshot meant as evidence of the error state shows an ordinary card instead.
- **Do this:** screenshot the wrapper (`card.locator("xpath=..")`). And assert the pill with
  `getByText("Couldn’t load the video.")`, not `getByRole("alert")` — Next's route announcer is an
  alert too. Note the TYPOGRAPHIC apostrophe (the source is `Couldn&rsquo;t`) and that this copy
  ("Couldn’t load the video.") differs from `MediaPlayer`'s ("Couldn’t load video").

## A grep guard that collapses whitespace is STILL defeated by `<\n video`
**(11 Sep 2026, ENG-1063.)** `test/feed-hls-video.test.tsx`'s bare-`<video>` guard
collapsed `\s+` → `" "` and then asked `.includes("<video")`. That handles a wrap
*inside* the tag but not one between `<` and the tag name: `<\n video src=... />`
collapses to `"< video"` and sails through. It is shippable source — `tsc --noEmit`
exits 0 and esbuild parses it — so this was a real hole, not a curiosity.
→ Match `/<\s*video\b/`, never a substring. Same applies to any other
element-grep guard in this repo.

## An anchor written against the constant it guards is a tautology
**(11 Sep 2026, ENG-1063.)** To stop a console-spy guard going vacuous I added
`expect(spies).toHaveLength(CONSOLE_METHODS.length)`. Emptying `CONSOLE_METHODS`
— the exact mutation it was meant to catch — left the file 26/26 GREEN, because
the assertion degrades to `0 === 0`. The positive-control loop
`for (const m of CONSOLE_METHODS) console[m](x)` was tautological the same way.
→ Anchor against a LITERAL (`toBeGreaterThanOrEqual(6)`, `toContain("log")`) and
drive the control through named sinks (`console.log(...)` directly), not through
the array under test. And always run the mutation to confirm the anchor bites —
this one was only caught by doing so.

## Explore cannot hold guardrail 3 on its own — don't write a test that claims it does
**(11 Sep 2026, ENG-1063.)** `app/(member)/explore/explore-feed.tsx`'s aside signs
trainer photos from an effect with `[]` deps; `gated` is only known once the
`/api/feed` 402 resolves, so there is no FE gate to assert. A "lapsed viewer signs
nothing" test written with the realistic NULL-embed fixture is over-determined
three times (empty `trainerMap` → `trainerIds.length === 0` early return →
`signPhotoMap`'s own `paths.length === 0` return in `lib/storage/photos.ts`).
VERIFIED: deleting the early return leaves the whole file green, and the same test
passes for an entitled viewer. The property rests on the BE policy
`trainer_select_sub`, which the FE does not own.
→ Don't title such a test a lapsed-session guard. Pin the gap as an explicit
characterization test instead, and treat the signing-order restructure as the
only thing that can make the observable property real.
