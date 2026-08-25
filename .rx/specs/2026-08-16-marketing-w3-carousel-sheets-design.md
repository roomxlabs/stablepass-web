# Marketing v1 — W3 · web · Trainer marquee + the four sheets

Ticket: **ENG-589** · Epic: **ENG-586** · Base branch: `feature/marketing-v1` · Blocked by: ENG-588 (W2)

## Context / why

W2 renders the trainer strip as a static row and the footer's Support/Legal buttons as inert. This ticket
adds the interactive layer: the marquee, the trainer modal, and the four sheets. Last of the v2.6 port.

The source is ~6.6 KB of hand-written vanilla JS in the mockup's third `<script>` block. It is more
considered than it looks — read it before rewriting it.

## Scope decisions (locked)

1. **The marquee is a `requestAnimationFrame` driver, not a CSS keyframe.** Deliberate in the source: the
   arrows nudge the same offset the animation is using, which a keyframe cannot do.
2. **The duplicate set must never be simultaneously visible.** The source only clones the card set when
   `setWidth > stripWidth + leadCardWidth`, otherwise it adds `.is-static` and renders a plain centred row.
   With few trainers a naive clone shows the same face twice. Keep this guard exactly.
3. **Three input modes, all in the source, all required:**
   - `(hover: none)` (touch) → no rAF at all; native scroll, arrows call `scrollBy({behavior:'smooth'})`
   - hover-capable → rAF drift, `mouseenter` pauses, `mouseleave` resumes
   - `prefers-reduced-motion: reduce` → no drift; arrows still nudge
4. **Resize rebuilds**, debounced 150 ms, cancelling the previous rAF and resetting the offset. The gap is
   **read from `getComputedStyle`**, not passed in, because it changes at the phone breakpoints.
5. Cloned cards get `aria-hidden="true"`, `data-dup="1"` and have `tabindex` removed. Without it the
   duplicate set is in the tab order and read twice by a screen reader.
6. **The contact sheet is a `mailto:`.** v2.6 shows a form and a "Thanks, that is on its way" confirmation
   with no backend behind it — a mockup affordance, not a feature. Replace it with a `mailto:` composed
   from the trigger's `data-subject`. **No fake success state, no fetch, no third-party form service.**
7. **Privacy and Terms sheets are replaced by real navigation to W4's routes.** Do not port their content
   here. The footer's four Legal buttons become links.
8. `data-trainer-count` on the section stays. It is how the strip decides static vs marquee.

IN: the marquee, the trainer modal, the FAQ sheet, the contact mailto, wiring the footer's Legal buttons.
OUT: legal page content (W4), middleware/metadata (W5), any backend call, any form submission.

## Surface (files this ticket owns)

```
app/(marketing)/trainer-carousel.tsx           (new — the rAF marquee, client component)
app/(marketing)/use-marquee.ts                 (new — the driver, extracted so it is unit-testable)
app/(marketing)/modals/trainer-modal.tsx       (new — #tr-modal)
app/(marketing)/modals/faq-sheet.tsx           (new — #sheet-faq)
app/(marketing)/modals/contact-mailto.ts       (new — builds the mailto: href)
app/(marketing)/modals/sheet.tsx               (new — shared dialog shell: focus trap, Esc, scrim)
test/marketing-marquee.test.ts                 (new)
test/marketing-sheets.test.tsx                 (new)
e2e/marketing-interactive.spec.ts              (new)
```

Shared-surface edits, minimal diff, declared:

```
app/(marketing)/sections/trainers-strip.tsx    (EDIT — swap the static row for <TrainerCarousel/>)
app/(marketing)/footer.tsx                     (EDIT — Legal buttons become links to /legal/*; Support
                                                 buttons become the contact mailto + FAQ sheet trigger)
```

Do-NOT-touch: `marketing.css` (W1 — if a rule is genuinely missing, say so on the PR rather than editing),
the other eleven section files, `app/(marketing)/legal/**` (W4), `middleware.ts` / `next.config.ts` (W5),
`app/(member)/**`, `app/start/**`.

## Migration

None.

## Design (CONFIRMED — verified 16 Aug 2026)

`10-marketing-site/deploy/src/mockup.html`, third `<script>` block plus the `.sheet` / `.tr-modal` markup.
Behaviour reference: `https://stablepass-marketing-preview.vercel.app`.

### The DOM contract in the source

- `#stable-trainers` — the trainer section, carries `data-trainer-count`
- `[data-tr]` — a trainer card; opens `#tr-modal`
- `#tr-modal` — `role="dialog" aria-modal="true" aria-labelledby="trm-name"`
- `#sheet-contact`, `#sheet-faq`, `#sheet-privacy`, `#sheet-terms` — `.sheet`, each `role="dialog"
  aria-modal="true"` with its own `aria-labelledby`
- `[data-sheet="contact|faq|privacy|terms"]` — the triggers; contact triggers also carry `data-subject`
- `[data-ma="-1|1"]` — the previous/next arrows
- `[data-close]` — close buttons
- Events bound in the source: `click`, `keydown` (Esc), `mouseenter`, `mouseleave`, `resize`, `submit`

### The trainer modal's copy

v2.6's modal says: *"On the live site this opens the trainer's own page, where you can see every horse they
have nominated and follow the stable."* Placeholder text describing a page that does not exist in this
epic. **Keep it verbatim** — it is client-signed-off, and the real trainer page arrives with the admin-CMS
epic.

## States & edge cases

- **No JS** — the strip renders as a static row of all 19 cards, scrollable natively. Sheets do not open;
  the Legal links still navigate (real `<a>` after this ticket). The contact `mailto:` still works. This is
  the client's review condition, so verify it, don't assume it.
- **`prefers-reduced-motion`** — no drift, arrows still work.
- **Touch** — native scroll + arrow nudge, no rAF.
- **≤4 trainers** — `.is-static`, centred row, no clones, no animation.
- **0 trainers** — section hidden entirely.
- **Strip wider than one set** — no clone; falling back to static is correct, not a bug.
- **Esc / scrim click / close button** — all close and return focus to the trigger.
- **Two dialogs** — only one open at a time.
- **Resize mid-drift** — debounced rebuild, offset reset.

## Guardrails (must hold — `.rx/guardrails.md`)

- **#1 no backend access** — no `lib/supabase/*`, no `fetch` to any origin. The contact path is a `mailto:`
  and nothing else.
- **No fictional integrations** — the contact sheet must not render a success state it cannot deliver.
  This is the thing being fixed, not preserved.
- **#2 no owner PII** — the trainer modal shows name, location, photograph and the placeholder bio. Never
  `trainer_contact` data.
- **#8 no betting / bookmaker anything.**

## Acceptance criteria (observable)

- [ ] With 19 trainers on a hover-capable desktop the strip drifts, pauses on hover, resumes on leave.
- [ ] The same card is never visible twice at once at 1440, 1024 and 768.
- [ ] On touch emulation there is no rAF loop; arrows scroll natively.
- [ ] With `prefers-reduced-motion: reduce` there is no drift and the arrows still work.
- [ ] Clicking a trainer card opens the modal with that trainer's name, location and photograph.
- [ ] Esc, the scrim and the close button all close, and focus returns to the trigger.
- [ ] The footer's Privacy / Terms / Cancellation / Acceptable Use are real links to `/legal/*`.
- [ ] The contact trigger opens the mail client with the right subject. **No in-page "sent" confirmation
      exists anywhere in the built output.**
- [ ] With JS disabled: all 19 cards visible, legal links navigate, nothing stuck at `opacity:0`.
- [ ] A GIF or short recording of the marquee attached (a still cannot show drift).

## Tests that must pass (the loop's pass/fail)

- [ ] unit: the clone decision — given set/strip/lead widths, asserts clone vs `.is-static` at the
      boundary. This is the "same card twice" guard; test it directly.
- [ ] unit: offset wraps at `setW` in both directions (nudge -1 from 0 does not go negative).
- [ ] unit: `prefers-reduced-motion` and `hover:none` each select the right mode.
- [ ] component: clones carry `aria-hidden="true"` and are absent from the tab order.
- [ ] component: Esc closes the open sheet and focus returns to the trigger.
- [ ] component: only one dialog is open at a time.
- [ ] guardrail: grep the built output for a success/confirmation string from the old contact form —
      **must be absent**.
- [ ] guardrail: grep — no `fetch(` and no `lib/supabase` import under `app/(marketing)/`.
- [ ] `npm run typecheck && npm run lint && npm run build && npm test` green.

## Dependencies

Blocked by: ENG-588 (W2) — edits `trainers-strip.tsx`, which W2 creates.

## Open questions — RESOLVED

- Q: keep the contact form and wire it to something? A: no. `mailto:` only.
- Q: port the privacy/terms sheet content here? A: no, W4 owns it as real pages.
- Q: rewrite the marquee as CSS animation? A: no, decision 1.

## Definition of done

- [ ] acceptance criteria met
- [ ] listed tests written + green; repo's full suite green
- [ ] motion evidence attached
- [ ] PR opened into `feature/marketing-v1`
