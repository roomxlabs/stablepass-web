# Marketing v1 — W5 · web · Host routing + metadata

Ticket: **ENG-591** · Epic: **ENG-586** · Base branch: `feature/marketing-v1` · Blocked by: ENG-587 (W1) ·
**`shared-surface`** — introduces the repo's first `middleware.ts`, which runs on every request.

## Context / why

One Next app, one Vercel project, two domains. This slice makes the host decide the URL space, and re-homes
the signed-in redirect W1 deleted along with `app/page.tsx`.

Per `.rx/gotchas.md`: *"No CSRF/origin check anywhere in this repo. There is no `middleware.ts`."* This
ticket creates it. Highest blast radius in the epic — a mistake here 404s or redirect-loops the entire
member app, not just marketing.

## Scope decisions (locked)

1. **PRESENCE check only. Never `getUser()`, never `supabaseServer()`, never any Supabase call in
   middleware.** A network round-trip on every request would make the whole app dynamic and defeat the
   caching the subdomain split exists to protect. Middleware reads *whether* an auth cookie exists and
   nothing more. A stale cookie sending someone to `/explore` is fine — the page's own gate handles it.
2. **Match the cookie by PREFIX, not by exact name.** `@supabase/ssr` chunks large sessions into
   `sb-stablepass-web-auth.0`, `.1`, … The base name is `AUTH_COOKIE_NAME` in
   `lib/supabase/cookie-name.ts`. An exact-name check silently fails for any member whose session is
   chunked, which is the majority. Import the constant; do not retype the string.
3. **Host → URL space:**
   - apex (`stablepass.co`, `www.stablepass.co`) → the `(marketing)` space. `www` 308s to the bare apex.
   - app host (`app.stablepass.co`) → the member space. `/` 308s to `/explore` when the cookie is present,
     `/signin` when it is not.
   - `/legal/*` serves on **both** hosts (W4 owns the pages; middleware must not block them).
   - Member routes requested on the apex 308 to the same path on the app host, and vice versa for `/`.
4. **Local development does NOT do host routing.** On `localhost` both spaces serve unprefixed: `/` is the
   marketing home, `/explore` is the member app. Gating dev behind an `/etc/hosts` edit would break every
   existing workflow and the Playwright harness. Hosts come from env (`NEXT_PUBLIC_MARKETING_HOST`,
   `NEXT_PUBLIC_APP_HOST`) with the localhost bypass explicit and tested.
5. **`canonical` is fixed.** The mockup head carries `<link rel="canonical" href="https://stablepass.com/">`
   and `og:url` pointing at the same. **`stablepass.com` is an unrelated third party's website** (a
   password generator). Both become `https://stablepass.co/`.
6. **Robots, two rules, one flag:**
   - the member space is **always** `noindex`,
   - the marketing space is `noindex` **until real trainer bios land**, controlled by a single exported
     constant with a comment naming the condition. 19 named trainers' photographs currently sit beside
     "Trainer bio to come from the stable". Flipping it must be one edit, not a hunt.
7. Marketing metadata comes from the mockup head verbatim: title, description, keywords, `og:*`,
   `twitter:*`, `theme-color: #285D50`, `og:locale: en_AU`. `10-marketing-site/deploy/public/og.jpg` moves
   to `public/`.
8. The `x-concept` meta tag and the "Every tag above is editable from the admin portal" comment are
   **dropped**. The first is a working note; the second describes a CMS that does not exist.

IN: `middleware.ts`, host config, the redirects, marketing metadata, canonical, robots, `og.jpg`.
OUT: page content (W1–W4), Vercel domain attachment and DNS (ENG-593), `app/(member)/**`, `app/api/**`.

## Surface (files this ticket owns)

```
middleware.ts                                (new — the repo's first)
lib/hosts.ts                                 (new — host constants, localhost bypass, typed)
lib/seo.ts                                   (new — canonical + the single noindex flag)
app/(marketing)/layout.tsx                   (EDIT — add `metadata`; W1 created it, merged before this)
app/robots.ts                                (new)
public/og.jpg                                (new — moved from the deploy repo)
test/middleware.test.ts                      (new)
test/seo-metadata.test.ts                    (new)
```

Do-NOT-touch: `app/(marketing)/sections/**` (W2), `app/(marketing)/modals/**` and `trainer-carousel.tsx`
(W3), `app/(marketing)/legal/**` (W4 — but middleware must let it through on both hosts),
`app/(member)/**`, `app/api/**`, `app/start/**` (ENG-571), `lib/supabase/cookie-name.ts` (**import** it,
never edit it).

## Migration

None.

## Behaviour / contract

```
GET https://stablepass.co/                    -> 200 marketing home
GET https://www.stablepass.co/*               -> 308 https://stablepass.co/*
GET https://stablepass.co/legal/privacy       -> 200 (canonical: self)
GET https://stablepass.co/explore             -> 308 https://app.stablepass.co/explore

GET https://app.stablepass.co/      (cookie)  -> 308 /explore
GET https://app.stablepass.co/   (no cookie)  -> 308 /signin
GET https://app.stablepass.co/explore         -> 200 member app (its own gate applies)
GET https://app.stablepass.co/legal/privacy   -> 200 (canonical: https://stablepass.co/legal/privacy)
GET https://app.stablepass.co/start           -> 200 signup (ENG-571's screen)

GET http://localhost:3000/                    -> 200 marketing home   (no host routing in dev)
GET http://localhost:3000/explore             -> 200 member app
```

## States & edge cases

- **Chunked auth cookie** (`...auth.0`, `.1`) — must be detected. The single most likely way to ship this
  broken.
- **Expired / invalid cookie** — still counts as present; the page's gate redirects. Accepted, decision 1.
- **Redirect loop** — `/` → `/explore` → `/` is the failure mode to guard. Middleware must not run its root
  rule on any path other than exactly `/`. Assert it.
- **Static assets and `_next/*`** — excluded via the matcher. `public/marketing/*` must never be rewritten.
- **`/api/*` on the apex** — the BFF belongs to the app host only. 404 or redirect, never serve it from the
  marketing origin.
- **Unknown host** (preview deployments, `*.vercel.app`) — must not 404 the world. Default to the app
  space. Vercel preview URLs are how PRs get reviewed.
- **Trailing slash / case in the Host header** — normalise before comparing.

## Guardrails (must hold — `.rx/guardrails.md`)

- **#1 the browser never sees the backend URL or a token** — middleware makes **no** Supabase call and
  reads no token value. It checks for a cookie's existence, never decodes it, never logs it.
- **#3 content is subscription-gated** — middleware is **not** a gate and must not be treated as one. The
  402 gate stays in the BFF and in `lib/api/access.ts`. A presence check that looks like a gate is worse
  than no gate. Note the standing gotcha: `app/(member)/**` also reads Supabase directly, so middleware
  could never have been the boundary anyway.
- **#9 secrets from env** — host names are `NEXT_PUBLIC_*`; nothing secret enters middleware.

## Acceptance criteria (observable)

- [ ] Every row of the contract table behaves as written, verified in a test.
- [ ] A **chunked** auth cookie (`sb-stablepass-web-auth.0`) is detected as present.
- [ ] No redirect loop on any path, proven by a test that follows redirects to completion.
- [ ] `middleware.ts` contains no import of `lib/supabase/server` and no `await` on any network call.
- [ ] The built output contains **no** reference to `stablepass.com` anywhere.
- [ ] The member space emits `noindex`; the marketing noindex is one constant with a comment naming the
      flip condition.
- [ ] `npm run dev` on `localhost:3000` serves marketing at `/` and the member app at `/explore`, with no
      hosts-file change.
- [ ] The existing Playwright specs still pass unchanged.

## Tests that must pass (the loop's pass/fail)

- [ ] middleware: each host/path/cookie combination in the contract table returns the expected status and
      `Location`.
- [ ] middleware: chunked-cookie detection (`.0` suffix) — the decision-2 trap, tested directly.
- [ ] middleware: `/` on the app host with no cookie → `/signin`; with cookie → `/explore`; neither target
      itself redirects (loop guard).
- [ ] middleware: `localhost` bypass serves both spaces.
- [ ] middleware: `_next/*` and `/marketing/*` are untouched by the matcher.
- [ ] guardrail: grep — `middleware.ts` imports no Supabase client.
- [ ] seo: canonical and robots resolve correctly per host; no `stablepass.com` in any emitted tag.
- [ ] the full existing suite stays green — this is the shared-surface risk.
- [ ] `npm run typecheck && npm run lint && npm run build && npm test` green.

## Dependencies

Blocked by: ENG-587 (W1) — edits the marketing layout W1 creates.
Related: ENG-590 (W4) — middleware must let `/legal/*` through on both hosts. Not a blocker; write the
matcher so the legal routes work whether or not W4 has merged.

## Open questions — RESOLVED

- Q: validate the session in middleware? A: **no.** Presence only, decision 1.
- Q: how does local dev work? A: no host routing on localhost, decision 4.
- Q: apex or `www` canonical? A: bare apex; `www` 308s to it.
- Q: does middleware become the content gate? A: no. Routing, not authorisation.

## Definition of done

- [ ] acceptance criteria met
- [ ] listed tests written + green; **the repo's full suite green** (shared surface)
- [ ] PR opened into `feature/marketing-v1`
