/**
 * Canonical URLs + the one indexing switch (ENG-591 / W5).
 *
 * The mockup head shipped a `<link rel="canonical">` — and a matching `og:url` —
 * pointing at the `.com` of the same name. That domain belongs to an unrelated
 * third party (a password generator), so pointing the canonical at it would
 * hand them the ranking. Every canonical here is derived from `MARKETING_HOST`,
 * which is why that address cannot come back by hand.
 */
import { MARKETING_HOST } from "./hosts";

/** The canonical origin for everything public. Bare apex, never `www`. */
export const CANONICAL_ORIGIN = `https://${MARKETING_HOST}`;

/**
 * Whether the marketing space may be indexed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FLIP THIS TO `true` WHEN REAL TRAINER BIOS LAND. That is the whole condition.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * It is `false` because the site publishes 19 real trainers' photographs beside
 * the placeholder line "Trainer bio to come from the stable". Indexing real,
 * named people next to placeholder biography is the specific thing being
 * avoided — this is not a generic pre-launch precaution.
 *
 * This single constant is the entire switch. Three surfaces read it and nothing
 * else decides indexing for the marketing space:
 *   1. `app/robots.ts`                 — the `/robots.txt` body
 *   2. `app/(marketing)/layout.tsx`    — the `<meta name="robots">` tag
 *   3. `middleware.ts`                 — the `X-Robots-Tag` response header
 *
 * The MEMBER space is `noindex` unconditionally (it is all behind auth) and is
 * deliberately NOT governed by this flag — flipping this must never expose it.
 */
export const MARKETING_IS_INDEXABLE = false;

/**
 * Absolute canonical URL for a public path, always on the marketing apex.
 *
 * `/legal/*` serves on BOTH hosts, so a legal page reached at
 * `https://app.stablepass.co/legal/privacy` must still name
 * `https://stablepass.co/legal/privacy` as its canonical. Pass the pathname and
 * this returns the right answer regardless of which host served the request.
 *
 * NOTE for W4 (ENG-590, `/legal/[slug]`): the marketing layout sets a canonical
 * of `/` for the home page, and Next inherits layout metadata into child pages.
 * The legal page therefore needs its OWN `alternates.canonical`, built with this
 * helper — otherwise all four legal slugs inherit the home page's canonical.
 */
export function canonicalFor(pathname = "/"): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${CANONICAL_ORIGIN}${path}`;
}
