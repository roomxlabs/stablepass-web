# Marketing v1 — W4 · web · Legal routes

Ticket: **ENG-590** · Epic: **ENG-586** · Base branch: `feature/marketing-v1` · Blocked by: ENG-587 (W1)

## Context / why

**This fixes a live defect.** `app/start/trial-start-form.tsx:90` renders `<a href="/legal/terms">Terms</a>`
and `<a href="/legal/privacy">Privacy Policy</a>` on the signup form, and **both 404 today**. There is no
`/legal` route anywhere in the repo.

It is also a launch dependency: the App Store submission needs a reachable privacy policy URL, and mobile's
`SUPPORT_LINKS.privacy` is hardcoded `null` precisely because no such URL exists
(`stablepass-mobile/src/app/(tabs)/me/index.tsx:56`).

Wix was going to own these pages. It no longer does.

## Scope decisions (locked)

1. **The routes render on BOTH hosts.** `stablepass.co/legal/*` and `app.stablepass.co/legal/*` both serve.
   That is what makes the fix a no-op for the member app: the signup form's links are **relative**, so they
   resolve on the app host with **no edit to `trial-start-form.tsx`**. That file is owned by ENG-571, in
   progress — this ticket must not touch it.
2. **`canonical` points at the apex** (`https://stablepass.co/legal/<slug>`) from both hosts, so the
   duplicate render has one canonical URL for Apple, Stripe and search.
3. **Four slugs. Two documents.**
   - `/legal/privacy` → the privacy page
   - `/legal/terms` → the terms page
   - `/legal/cancellation` → **308 to `/legal/terms`**
   - `/legal/acceptable-use` → **308 to `/legal/terms`**
   Mirrors v2.6 exactly: its footer has four buttons and `data-sheet="terms"` is on three of them. There is
   no distinct cancellation or acceptable-use copy in existence. Redirecting is honest; inventing legal
   text is not.
4. **Content is the v2.6 draft body, with the preview banner REMOVED.** Each sheet currently opens with
   *"This preview shows where the policy sits and how it opens. The final wording will be supplied by
   stablepass. and loaded as its own page before launch."* That sentence must not ship. The substantive
   body below it does.
5. **Content lives in `content/legal/*.md`**, not in JSX, so swapping in the client's final wording is a
   one-file change with no engineering. Render with the repo's existing dependencies — **no new markdown
   library**; a small typed renderer or plain structured TS is fine if adding a dep is the alternative.
6. Each page carries a visible **"Last updated"** date from the content file's frontmatter.
7. Any slug outside the four returns a genuine **404**, not a redirect to terms.

IN: the four routes, the two documents, the shared legal layout.
OUT: `trial-start-form.tsx` (ENG-571 owns it, and no edit is needed), footer wiring (W3), middleware and
canonical infrastructure (W5), mobile's privacy link (M1), writing new legal text.

## Surface (files this ticket owns)

```
app/(marketing)/legal/[slug]/page.tsx        (new — the four slugs, generateStaticParams)
app/(marketing)/legal/legal.module.css       (new — prose styling, scoped)
content/legal/privacy.md                     (new — v2.6 body, banner stripped, frontmatter date)
content/legal/terms.md                       (new — same)
lib/legal.ts                                 (new — slug → document, the two redirect slugs, typed)
test/legal-routes.test.tsx                   (new)
```

Do-NOT-touch: `app/start/**` (ENG-571), `app/(marketing)/footer.tsx` (W3),
`app/(marketing)/sections/**` (W2), `middleware.ts` / `next.config.ts` (W5), `app/globals.css`,
`app/(member)/**`.

## Migration

None.

## Design (CONFIRMED — verified 16 Aug 2026)

Content source: `10-marketing-site/deploy/src/mockup.html`, the `#sheet-privacy` and `#sheet-terms`
containers. Visual treatment: the mockup's `.sheet` prose styling, reflowed to a full page rather than a
dialog. Heading, last-updated line, body sections. Match the marketing type scale W1 ported.

## States & edge cases

- **Unknown slug** — 404 (`notFound()`), not a redirect.
- **`/legal` with no slug** — 404. There is no index page in the design.
- **No JS** — fully readable. Prose pages; nothing may depend on scripting.
- **Requested on the app host** — renders identically, canonical still points at the apex.
- **Deep-linked from mobile or an app-store listing** — renders standalone, marketing nav and footer, no
  member-app chrome and no auth requirement.

## Guardrails (must hold — `.rx/guardrails.md`)

- **#1 the browser never sees the backend URL or a token** — no Supabase import. These pages must be
  reachable **signed out**, which is the entire point. Do not put them behind any gate.
- **#9 secrets from env** — none involved.
- The pages must be **statically rendered** (no `cookies()`, no dynamic APIs). A legal page that goes
  dynamic because something read a cookie defeats the caching the subdomain split exists to protect.

## Acceptance criteria (observable)

- [ ] `/legal/privacy` and `/legal/terms` return 200 and render the full body.
- [ ] `/legal/cancellation` and `/legal/acceptable-use` return 308 to `/legal/terms`.
- [ ] `/legal/nonsense` returns 404.
- [ ] **From the signup form at `/start`, both existing legal links now resolve instead of 404ing** — the
      whole reason this ticket exists. Verified without editing that file.
- [ ] The string "This preview shows where the policy sits" appears **nowhere** in the built output.
- [ ] Every page emits `<link rel="canonical" href="https://stablepass.co/legal/<slug>">`.
- [ ] Both pages render with JavaScript disabled.
- [ ] Screenshots of both pages at 1440 and 390 attached.

## Tests that must pass (the loop's pass/fail)

- [ ] route: 200 for `privacy` and `terms`; 308 → `/legal/terms` for `cancellation` and `acceptable-use`;
      404 for an unknown slug.
- [ ] content: the built output contains no "This preview shows" and no "will be supplied by stablepass".
- [ ] route: canonical is the apex URL regardless of which host rendered it.
- [ ] guardrail: grep — no `lib/supabase` import and no `cookies()` under `app/(marketing)/legal/`.
- [ ] `npm run typecheck && npm run lint && npm run build && npm test` green.

## Dependencies

Blocked by: ENG-587 (W1) — needs the marketing layout and stylesheet.
**Not** blocked by ENG-571, because decision 1 removes the need to edit `trial-start-form.tsx`.

## Open questions — RESOLVED

- Q: apex-only or both hosts? A: both, canonical to apex. Apex-only would force absolute URLs into
  `trial-start-form.tsx`, colliding with ENG-571 for no gain.
- Q: four documents or two? A: two, with two redirects.
- Q: ship the draft wording? A: yes, minus the preview banner. The client's final wording is a **go-live
  gate on ENG-593 (OPS)**, not a blocker here — the routes must exist either way to clear the 404.

## Flag for the client, do not fix in code

`content/legal/privacy.md` will say the product collects **"year of birth"**. It does not: ENG-571 collects
first name, last name, email, phone and postcode. A privacy policy describing collection that does not
happen is the client's to correct. Raise it on the PR; do not silently edit their legal copy.

## Definition of done

- [ ] acceptance criteria met
- [ ] listed tests written + green; repo's full suite green
- [ ] screenshots attached
- [ ] the year-of-birth discrepancy raised on the PR
- [ ] PR opened into `feature/marketing-v1`
