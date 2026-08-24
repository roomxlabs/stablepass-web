# Marketing v1 — M2 · web · marketing pages (ENG-281) + M3 · legal-link repoint (ENG-282)

Epic: ENG-279 · Base branch: `feature/marketing-v1` (SEED FROM `feature/member-web-v1` — root app/page.tsx exists only there) · M2 blocked by ENG-280; M3 blocked by ENG-281.

## Design (CONFIRMED reference)
`10-marketing-site/stablepass-concept-b-v2.html` — Concept B + 14 Jul client feedback + copy v2 normalized to "subscription" wording. Mockup wins visuals; ticket wins behaviour. Copy source: Stablepass Overview v2.docx (subscription-normalized; change-list flagged to client).

## M2 surface
`app/page.tsx` (signed-out → marketing home; signed-in → /explore unchanged) · `app/(marketing)/**` (layout/nav/footer, home sections, trainers/page.tsx, faq/page.tsx, legal/[slug]/page.tsx placeholders) · `app/(marketing)/trainer-carousel.tsx` + module CSS · `test/marketing-*.test.tsx`.

## M2 behaviour
- Single-page home: hero (S overlay) → what-is → how-it-works (4 steps) → experience → $19/month (fixed spacing) → why-different → trainer carousel ("The trainers in our stable") → FAQ preview (top 4-6 published + View all) → CTA → footer (disclaimer + legal links). Menu smooth-scrolls; Trainers menu opens /trainers in NEW TAB.
- Carousel is ADAPTIVE (client 20 Jul: launch may have ~3 trainers): count ≤4 → static centered row, no animation, no duplicate cards; count >4 → auto-scroll loop + swipe with the duplicate set NEVER simultaneously visible (insufficient strip width → fall back to static row); count 0 → section hidden; no photo → initial-avatar fallback. Server-read `public_trainer` (anon view); hover reveals name+city.
- Section spacing: generous consistent vertical rhythm between full-bleed/rounded sections — no flush edges (client 20 Jul).
- /faq: all published, sort_order; quiet empty state. /trainers: partner page from copy v2. Contact CTAs = mailto (placeholder addresses in one constant file until client supplies). "Join stablepass." → /start.
- SEO: per-page metadata from the doc's meta descriptions; body text carries keywords, no tag lists.

## M2 guardrails
Anon client only on marketing pages — no service role, no elevated reads, no member data · disclaimer text verbatim (no shares/syndicate/betting) · no bookmaker anything · /preview/components gains no links.

## M3 (ENG-282)
Repoint dead member-app `/legal/*` hrefs (signin/start screens) to M2's routes. Minimal diff; do NOT touch /forgot-password (missing feature, out of scope). grep proves no dead legal hrefs remain.

## Acceptance
M2: component tests (carousel fallback/hidden-empty, FAQ preview published-only, Trainers new-tab attr); typecheck+lint+build+test green; home/trainers/faq screenshots (desktop+mobile) on PR. M3: grep + tests green.
