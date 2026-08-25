# Marketing v1 — W1 · web · Marketing shell, extracted assets, scoped stylesheet

Ticket: **ENG-587** · Epic: **ENG-586** (supersedes the cancelled ENG-279) · Base branch:
`feature/marketing-v1` (off `origin/main`) · Blocks: ENG-588 (W2), ENG-589 (W3), ENG-590 (W4), ENG-591 (W5)

## Context / why

`stablepass.co` is a Wix "coming soon" waitlist page today, and the original plan had the client keep the
marketing site on Wix. That plan is dropped: the custom Concept B v2.6 page replaces it, served from this
repo. This ticket lands the shell that every other marketing slice builds inside, and gets the 3.3 MB of
inlined images out of the HTML and onto the CDN.

`stablepass-web` currently has no public page at all — `app/page.tsx` redirects signed-out visitors to
`/signin`.

## Scope decisions (locked)

1. **The design is FROZEN and client-signed-off.** Reimplement it faithfully. Any visual deviation from
   the reference is a defect, not an improvement. Do not "clean up" spacing, colour or copy.
2. **Marketing keeps its OWN font stack and its OWN stylesheet**, scoped to the marketing layout. It does
   **not** adopt the member app's Cormorant Garamond / Inter. Reconciling the two type systems would change
   a design the client has already approved.
3. Marketing tokens are declared on the marketing layout's root element, **not** on `:root` in
   `app/globals.css`. The member app's tokens must be untouched — several values are deliberately close but
   not equal (`--paper:#FAF9F4` vs `--cream:#FAF7F2`, `--ink:#1E2B26` vs `#1A1A1A`, `--gold:#C1913F` vs
   `#C9A56F`, `--line:#E3E5DB` vs `#E2DED6`). `--brand:#285D50` is the one exact match.
4. **`app/page.tsx` is DELETED.** It owns `/` today and would collide with the marketing route. Its
   signed-in → `/explore` redirect moves to `middleware.ts` in W5. Between W1 and W5 landing on the
   integration branch, a signed-in visitor to `/` sees marketing. That is accepted on the branch.
5. **All 43 image references are extracted** to `public/marketing/` and referenced by URL. 40 are unique
   (three are reused: the wordmark twice, and two photographs twice). Every extracted file must be
   **byte-identical** to the decoded base64 — no re-encoding, no optimisation pass, no format change.
   Name each file `<md5-8>.<ext>` so a re-extraction is verifiably identical.
6. **`next/image` is NOT used** in this slice. The mockup sizes everything with CSS
   (`img{max-width:100%;display:block;height:auto}`); swapping in `next/image` changes layout behaviour.
   Plain `<img>` with `loading="lazy"` below the fold.
7. The emoji placeholder favicon in the mockup head is dropped; the repo's existing
   `app/icon.png` / `app/apple-icon.png` are the marks.

IN: route group + layout, nav, footer, the stylesheet, the extracted assets, deleting `app/page.tsx`.
OUT: the home page sections (W2), carousel and modal behaviour (W3), legal routes (W4), middleware,
metadata, robots and canonical (W5), anything dynamic, anything in `app/(member)/**`.

## Surface (files this ticket owns)

```
app/(marketing)/layout.tsx                  (new)
app/(marketing)/nav.tsx                     (new)
app/(marketing)/footer.tsx                  (new)
app/(marketing)/marketing.css               (new — the ported stylesheet)
app/(marketing)/page.tsx                    (new — shell only; renders nav + a <HomeSections/> stub + footer)
app/(marketing)/sections/index.tsx          (new — the stub W2 replaces)
public/marketing/*.jpg|png                  (new — 40 extracted assets)
scripts/extract-marketing-assets.py         (new — the extraction, re-runnable and verifiable)
app/page.tsx                                (DELETE)
test/marketing-shell.test.tsx               (new)
e2e/marketing.spec.ts                       (new — see note)
```

Do-NOT-touch: `app/globals.css`, `app/layout.tsx`, `app/(member)/**`, `app/api/**`, `app/start/**`
(owned by ENG-571, in progress), `app/signin/**`, `.rx/mockups.md` (also ENG-571), `middleware.ts`,
`next.config.ts`, `e2e/screenshots.spec.ts`.

**Note on `e2e/`:** repo convention is to append to `e2e/screenshots.spec.ts`, but four web slices in this
epic need screenshots. Each owns its own spec file, matching the departure ENG-571 already recorded.

## Migration

None. No backend change in this epic.

## Design (CONFIRMED — verified readable at grill time, 16 Aug 2026)

```
10-marketing-site/deploy/src/mockup.html
```

Concept B · "Race Day" · **v2.6**, 4.75 MB, the exact file behind
`https://stablepass-marketing-preview.vercel.app`. This is the client-signed-off design and the only
source of truth. The `06-stage1-design/mockups/web/screens/01-marketing-home.html` entry in
`.rx/mockups.md` is the **dead Wix-era design** — ignore it; it pulls a video from `video.wixstatic.com`.

Read it with the data URIs stripped or your editor will choke:
`python3 -c "import re,pathlib;print(re.sub(r'data:image/[^\"\\')]+','X',pathlib.Path('mockup.html').read_text()))"`

### What to port in this slice

**Tokens** (from the mockup's `:root`, verbatim):
`--paper:#FAF9F4 --card:#FFFFFF --ink:#1E2B26 --mut:#5C6D64 --brand:#285D50 --deep:#1D453B
--sage:#E9EFE7 --sage2:#F1F4EC --gold:#C1913F --line:#E3E5DB`
`--serif:"Charter","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif`
`--sans:"Avenir Next",Avenir,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif`
`--mono:"SF Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace`
Body is `16.5px / 1.65`. `.wrap` is `max-width:1180px; padding:0 28px`.

**Nav** — `<nav class="nav">`: wordmark, then How it works · The app · Subscription · For trainers · FAQ,
then a "Join stablepass." CTA. All six are in-page anchors (`#how #app #subscription #trainers #faq #top`).
Keep them as anchors; `html{scroll-behavior:smooth}` does the work.

**Footer** — brand line, three columns (Explore / Support / Legal), copyright.
The Support and Legal columns are `<button data-sheet="...">`, not links — W3 wires their behaviour and W4
gives the legal ones real URLs. In this slice render them as the buttons the mockup has, inert.

**The `.js` / `.rv` scroll-reveal contract — load-bearing.** The mockup sets
`document.documentElement.className+=" js"` in the head, *before first paint*, and the reveal CSS is scoped
`.js .rv{opacity:0}`. With scripting off every section is simply visible instead of stuck at `opacity:0`.
**This must survive the port.** The client reviews on a phone with JS blocked, so a page that renders blank
without JS reads as broken. Port the head script as a `beforeInteractive` inline script or equivalent, and
keep the `.js`-scoped selectors. There is a `prefers-reduced-motion` branch that disables it too — keep that.

## States & edge cases

- **No JS** — every section visible, nav anchors work, layout intact. Non-negotiable (see above).
- **`prefers-reduced-motion: reduce`** — `scroll-behavior:auto`, no reveal transition, no animation.
- **Narrow viewport** — the mockup has phone breakpoints for nav and `.wrap` padding. Port them; do not
  invent new ones.
- **Image fails to load** — `alt` text is present on the content photographs in the mockup and must be
  carried over verbatim. Decorative tiles keep empty `alt=""`.

## Guardrails (must hold — `.rx/guardrails.md`)

- **#1 browser never sees the backend URL or a token** — this slice makes **no** Supabase call. The
  marketing layout must not import `lib/supabase/*`. That is what keeps the route statically cacheable and
  keeps the marketing origin off the auth-cookie path.
- **#2 no owner PII** — no horse-owner field anywhere. Trainer photographs and names are the supplied,
  client-approved assets; no contact details.
- **#8 no betting / bookmaker anything** — the page carries none; keep it that way.
- **#9 secrets from env** — nothing new. No key of any kind in the marketing bundle.

## Acceptance criteria (observable)

- [ ] `/` renders the marketing shell: nav, an empty content region, footer. No redirect to `/signin`.
- [ ] `public/marketing/` contains 40 files; the extraction script re-run produces byte-identical output
      (`md5sum` set unchanged). The PR shows that command and its output.
- [ ] The built page HTML contains **zero** `data:image/` occurrences.
- [ ] `app/globals.css` is unmodified (`git diff --stat` shows it absent).
- [ ] With JavaScript disabled, nav and footer render fully and no element sits at `opacity:0`.
- [ ] Desktop (1440) and phone (390) screenshots of the shell attached to the PR.

## Tests that must pass (the loop's pass/fail)

- [ ] component: the marketing layout renders nav with all six anchor targets and the footer's three columns.
- [ ] guardrail: `app/(marketing)/**` contains no import of `lib/supabase` and no `NEXT_PUBLIC_SUPABASE`
      reference (grep assertion — this is the guardrail that keeps the marketing origin cookie-free).
- [ ] guardrail: the built output contains no `data:image/` (asserts the extraction actually happened).
- [ ] `npm run typecheck && npm run lint && npm run build && npm test` green.

## Dependencies

Blocked by: none. This is the epic's root ticket.

## Open questions — RESOLVED

- Q: adopt the member app's Cormorant/Inter, or keep the mockup's stack?
  A: keep the mockup's stack, scoped. Changing it changes an approved design.
  **Known variance, accepted:** Charter and Iowan Old Style are system fonts present on iOS/macOS and
  absent on Android/Windows, which fall back to Georgia. The approved look is therefore the iOS look.
  Self-hosting the serif is a follow-up, not this ticket.
- Q: `next/image` or plain `<img>`?  A: plain `<img>`, see decision 6.
- Q: what happens to `app/page.tsx`?  A: deleted here; the redirect moves to middleware in W5.

## Definition of done

- [ ] acceptance criteria met
- [ ] listed tests written + green; repo's full suite green
- [ ] reads `CLAUDE.md` and follows its conventions
- [ ] screenshots attached
- [ ] PR opened into `feature/marketing-v1`, < ~400 line diff excluding the binary assets
