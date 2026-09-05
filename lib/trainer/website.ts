// The trainer website URL rules — ONE implementation, shared by a client
// component and a server component.
//
// WHY THIS MODULE EXISTS (ENG-959). The validation below started life inside
// `app/(member)/trainers/[id]/website-link.tsx`, which is a `"use client"`
// module. That is fine while the only caller is the component itself, but the
// horse profile is a SERVER component that needs to know, before it renders any
// wrapper, whether a link would be drawn at all. Exporting the function from the
// client module and calling it from the server fails at runtime with
//
//     Attempted to call hasLinkableWebsite() from the server but
//     hasLinkableWebsite is on the client.
//
// — a React Server Components boundary error, not a type error, so `tsc` is
// silent and a jsdom unit test that mocks the component never sees it either.
// It surfaced only in the Playwright run. A pure, directive-free `lib/` module
// is importable from both sides, which is what both callers actually need.

/**
 * Only absolute http(s) URLs are linkable. `trainer.website_url` is an
 * unconstrained `text` column, so a bare domain ("wallerracing.com.au") would
 * otherwise render as a RELATIVE href and silently resolve to
 * /trainers/<id>/wallerracing.com.au — a broken in-app link. Anything that isn't
 * a parseable http(s) URL yields null and renders no action at all (React
 * already neutralises `javascript:` hrefs; this doesn't rely on that).
 *
 * URL is used to VALIDATE only — we return the trainer's original string rather
 * than `url.href`, because normalisation would rewrite what the admin entered
 * (notably appending a trailing slash to a bare origin).
 */
export function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Does this trainer have a website we would actually draw a link to?
 *
 * The caller-side counterpart to `WebsiteLink`'s own internal guards, exported
 * because that component returning `null` is invisible to whoever WRAPPED it:
 * the horse profile puts its shares CTA in a spaced row of its own, and gating
 * that row on a merely non-empty `website_url` renders an empty box with a
 * margin — a phantom gap — for every trainer whose URL is not linkable. Not
 * hypothetical: a bare "wallerracing.com.au" is the likely admin entry.
 * Mobile gates on the validated href for the same reason (`contactHref` in
 * src/app/horse/[id].tsx).
 */
export function hasLinkableWebsite(websiteUrl: string | null | undefined): boolean {
  if (!websiteUrl || websiteUrl.trim() === "") return false;
  return safeHref(websiteUrl) !== null;
}
