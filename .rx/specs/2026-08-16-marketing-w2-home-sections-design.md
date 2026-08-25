# Marketing v1 — W2 · web · Home sections

Ticket: **ENG-588** · Epic: **ENG-586** · Base branch: `feature/marketing-v1` · Blocked by: ENG-587 (W1) ·
Blocks: ENG-589 (W3)

## Context / why

W1 lands the shell and renders a `<HomeSections/>` stub. This ticket replaces the stub with the real page:
the twelve content sections of the signed-off Concept B v2.6 design, between the nav and the footer.

## Scope decisions (locked)

1. **The design and the copy are FROZEN.** Every string is client-signed-off after several rounds. Copy it
   **verbatim**, including the lowercase trailing dot in "stablepass." and the Australian spellings. Do not
   rephrase, retitle, shorten, or fix what looks like a typo. If something reads wrong, flag it on the PR
   and ship it as-is.
2. **One component per section**, each its own file, so nothing in this ticket shares a file with W3.
3. **The trainer section's MARKUP is in this ticket; its BEHAVIOUR is W3.** Render all 19 trainer cards as
   a plain static row here. The auto-scroll marquee, hover pause, arrows and the trainer modal are W3.
4. Image `src` values point at the `public/marketing/<md5-8>.<ext>` files W1 extracted. Do not re-embed.
5. `.rv` reveal classes are carried over onto the same elements the mockup puts them on. The `.js`-scoped
   CSS is W1's; this ticket just keeps the class names correct.

IN: the twelve sections + `page.tsx` wiring.
OUT: carousel behaviour, sheets/modals, legal routes, middleware, metadata.

## Surface (files this ticket owns)

```
app/(marketing)/sections/hero.tsx                 (new)  header#top.hero
app/(marketing)/sections/what-is.tsx              (new)  section.sec
app/(marketing)/sections/how-it-works.tsx         (new)  section#how.sec.band
app/(marketing)/sections/the-app.tsx              (new)  section#app.sec
app/(marketing)/sections/subscribers-get.tsx      (new)  section#members.sec
app/(marketing)/sections/pricing.tsx              (new)  section#subscription.sec.price-sec
app/(marketing)/sections/why.tsx                  (new)  section.sec.why
app/(marketing)/sections/trainers-strip.tsx       (new)  section#stable-trainers.sec.tr-sec  (markup only)
app/(marketing)/sections/cta.tsx                  (new)  section (unnamed)
app/(marketing)/sections/faq.tsx                  (new)  section#faq.sec
app/(marketing)/sections/for-trainers.tsx         (new)  section#trainers.sec.train-band.train
app/(marketing)/sections/important-note.tsx       (new)  section.wrap.note-band
app/(marketing)/sections/index.tsx                (EDIT — replace W1's stub with the real composition)
app/(marketing)/sections/trainers.data.ts         (new)  the 19 trainers as a typed const
test/marketing-home.test.tsx                      (new)
```

Do-NOT-touch: everything W1 owns (`layout.tsx`, `nav.tsx`, `footer.tsx`, `marketing.css`, `page.tsx`,
`public/marketing/*`), `app/(marketing)/trainer-carousel.tsx` and `modals/**` (W3),
`app/(marketing)/legal/**` (W4), `middleware.ts` / `next.config.ts` (W5), anything in `app/(member)/**`,
`app/start/**` (ENG-571).

## Migration

None.

## Design (CONFIRMED — verified 16 Aug 2026)

`10-marketing-site/deploy/src/mockup.html` — Concept B · "Race Day" · v2.6.
Live reference: `https://stablepass-marketing-preview.vercel.app`.

Build against it **live**, section by section. Pull real values from the mockup's CSS; never eyeball a hex
or a spacing.

### The twelve sections, in document order

| # | Selector | Content |
|---|---|---|
| 1 | `header#top.hero` | eyebrow "RACING EXPERIENCE SUBSCRIPTION · FIRST 30 DAYS FREE", h1 "The racing experience made simple.", body, two CTAs, fine print, then the scrolling keyword ticker (STABLE UPDATES · RACE PREVIEWS · …, duplicated once) |
| 2 | `section.sec` | "What is stablepass." — eyebrow, h2 "A thoroughbred racing experience subscription.", three paragraphs |
| 3 | `section#how.sec.band` | "How it works" — h2 "Four steps. That's it.", four numbered steps. Phone layout is a vertical timeline |
| 4 | `section#app.sec` | "The stablepass. app" — h2, body, four labelled app screenshots |
| 5 | `section#members.sec` | "What subscribers get" — h2 "Inside your subscription", intro, four `.tile` cards, closing line, eight chips |
| 6 | `section#subscription.sec.price-sec` | "Subscription" — h2 "One simple subscription.", the price card (8 bullets), two CTAs, fine print |
| 7 | `section.sec.why` | "Why stablepass." — h2 "More than race day.", four paragraphs |
| 8 | `section#stable-trainers.sec.tr-sec` | "Participating stables" — h2 "The trainers in our stable.", intro, **19 trainer cards**, the disclaimer line. `data-trainer-count="19"` on the section |
| 9 | `section` (unnamed) | CTA band — "Your racing experience starts here.", body, two CTAs |
| 10 | `section#faq.sec` | "FAQ" — h2 "Good Questions", the accordion |
| 11 | `section#trainers.sec.train-band.train` | "For trainers" — why partner, content types, 5 steps, 6 numbered benefits, "A simple partnership", CTA |
| 12 | `section.wrap.note-band` | "Important note" — the no-shares/no-syndicate/no-betting disclaimer, **verbatim** |

### Trainer data

`trainers.data.ts` as `{ name, location, photo, initials }`. Every bio is the same placeholder string in
v2.6 ("Trainer bio to come from the stable. …") — one shared constant, not 19 copies. Photos are the
`.tr-init` assets W1 extracted.

Order, verbatim: Andrew Bobbin (Stawell, Victoria) · Annabel & Rob Archibald (Warwick Farm, NSW) ·
Archie Alexander (Ballarat, Victoria) · Corey & Kylie Geran (Toowoomba, Qld) · Danny Williams (Goulburn,
NSW) · Jack Bruce (Eagle Farm, Qld) · Jason Warren (Mornington, Victoria) · Jimmy Downes (Beaudesert, Qld) ·
Liam Birchley (Sunshine Coast, Qld) · Marc Chevalier (Hawkesbury, NSW) · Matt Hoysted (Eagle Farm, Qld) ·
Mitch Freedman (Ballarat, Victoria) · Phillip Stokes (Pakenham, Victoria) · Rob Heathcote (Eagle Farm,
Qld) · Robbie Griffiths (Cranbourne, Victoria) · Scott Singleton (Scone, NSW) · Shane Nichols (Mornington,
Victoria) · Chris Munce (Eagle Farm, Qld) · Matt Cumani (Ballarat, Victoria).

**This list becomes admin-driven in a later epic.** Structure it so swapping the const for a fetch is a
one-file change: a typed array with an exported `Trainer` type, consumed by a presentational component that
takes `trainers` as a prop.

## States & edge cases

- **No JS** — every section fully visible and readable. The FAQ accordion must use `<details>/<summary>`
  (as the mockup does) so it works with scripting off.
- **`prefers-reduced-motion`** — the hero ticker and any drift stop.
- **Phone (390)** — section 3 becomes a vertical timeline, the pricing pills must not wrap mid-word, the
  hero CTAs stack. All three are in the mockup's media queries; port them.
- **Trainer photo missing** — the mockup's `.tr-init` initials-disc fallback. Keep it.

## Guardrails (must hold — `.rx/guardrails.md`)

- **#1 no backend access** — no `lib/supabase/*` import in any section. Static only.
- **#2 no owner PII** — trainer name, location and photograph only. No contact details, no owner anything.
- **#8 no betting / bookmaker anything** — section 12's disclaimer is load-bearing. Reproduce it
  **verbatim**: no shares, no syndicates, no financial products, no betting products, no prize money
  rights, no investment returns. Do not paraphrase it.

## Acceptance criteria (observable)

- [ ] All twelve sections render in document order between nav and footer.
- [ ] Every nav anchor (`#how #app #subscription #trainers #faq #top`) scrolls to a real target.
- [ ] 19 trainer cards render with the correct name, location and photograph.
- [ ] The "Important note" disclaimer is character-identical to the mockup.
- [ ] With JS disabled the FAQ still opens and closes.
- [ ] Full-page screenshots at 1440 and 390, side by side with the same viewport from the mockup.

## Tests that must pass (the loop's pass/fail)

- [ ] component: all twelve sections mount; each nav anchor target id exists in the DOM.
- [ ] component: 19 trainer cards render from `trainers.data.ts`.
- [ ] component: the disclaimer text matches an exact expected string (guards against a paraphrase).
- [ ] guardrail: grep — no `lib/supabase` import under `app/(marketing)/sections/`.
- [ ] `npm run typecheck && npm run lint && npm run build && npm test` green.

## Dependencies

Blocked by: ENG-587 (W1) — needs the layout, the stylesheet and the extracted assets.

## Open questions — RESOLVED

- Q: rewrite the "$19 per month / cancel anytime" copy to match the non-renewing pass ENG-567 shipped?
  A: **No. Ship verbatim.** The mismatch is real and recorded on ENG-586 as a client conversation. Not this
  ticket's problem, and not a reason to hold this ticket.
- Q: static or dynamic trainers? A: static here. Dynamic is a later, ungrilled epic.

## Definition of done

- [ ] acceptance criteria met
- [ ] listed tests written + green; repo's full suite green
- [ ] side-by-side design-fidelity screenshots attached
- [ ] PR opened into `feature/marketing-v1`
