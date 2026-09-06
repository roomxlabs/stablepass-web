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
 * Public paths that stay crawlable even while `MARKETING_IS_INDEXABLE` is false.
 *
 * ENG-1041. Google Play's Data Safety form demands a publicly reachable URL for
 * requesting account and data deletion, and the listing cannot be completed
 * without one. `noindex` does not stop a reviewer opening a link, but it does
 * stop the person this page exists for — someone who has already uninstalled
 * the app and is searching for how to delete their data — from ever finding it.
 * So this one path is exempted.
 *
 * The exemption is safe precisely BECAUSE it is a path allowlist rather than a
 * flip of the flag above: the reason the marketing space is `noindex` is the 19
 * real trainers photographed beside placeholder biography, and none of them
 * appear on a deletion policy page. Widening this list to anything carrying a
 * trainer's name or photograph reintroduces exactly the harm the flag prevents.
 *
 * Read by the same three surfaces as the flag, and by the page's own metadata:
 *   1. `app/robots.ts`                                  — an `Allow:` beside the blanket `Disallow: /`
 *   2. `middleware.ts`                                  — suppresses the `X-Robots-Tag`
 *   3. `app/(marketing)/legal/delete-account/page.tsx`  — `robots: { index: true }`
 *
 * TWO DIFFERENT MATCH SEMANTICS, on purpose — know which is which before you
 * add an entry. `isAlwaysIndexablePath` is an EXACT match, so the header
 * exemption applies to this path and nothing beneath it. But `Allow:` in
 * robots.txt is a PREFIX rule, so the line this list generates also permits a
 * crawler to FETCH `/legal/delete-account/anything`. That is harmless today —
 * every such path 404s, and middleware still sends it `noindex` — but the day
 * someone adds a real child route under this path, robots.txt already lets it
 * be crawled and only the exact-match header is holding it out of the index.
 * Add the child to this list deliberately, or give it its own rule.
 *
 * MARKETING SPACE ONLY — but only two of the three surfaces can enforce that,
 * and it is worth being exact about which. `middleware.ts` and `app/robots.ts`
 * are host-aware and DO restrict the exemption to the marketing host. The third
 * surface, the page's own metadata, cannot: the page is `force-static`, so a
 * single HTML file is served on both hosts and its `<meta name="robots">` says
 * `index` on `app.stablepass.co` as well. The member space is still noindex
 * there, held by the header and by that host's `Disallow: /` — not by the tag.
 * Do not remove either of those on the grounds that the tag "already says so".
 *
 * `/legal/*` renders on the app host too and the canonical for every one of
 * those pages is the apex, so the app host's copy has nothing to gain from
 * being indexed and would only compete with it.
 */
export const ALWAYS_INDEXABLE_PATHS: readonly string[] = ["/legal/delete-account"];

/** Is this path exempt from the marketing-wide `noindex`? Exact match only. */
export function isAlwaysIndexablePath(pathname: string): boolean {
  return ALWAYS_INDEXABLE_PATHS.includes(pathname);
}

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
