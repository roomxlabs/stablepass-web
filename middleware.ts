/**
 * Host routing (ENG-591 / W5) — the repo's first middleware.
 *
 * This runs on EVERY request in the app, so it is deliberately small, totally
 * synchronous, and does no I/O. One Next app serves two domains: the apex is the
 * marketing site, `app.` is the member app. This file decides which URL space a
 * request belongs to and 308s anything that arrived on the wrong host.
 *
 * Two rules it must never break:
 *
 *   1. PRESENCE CHECK ONLY. No Supabase client, no session validation, no
 *      network round-trip, no I/O of any kind. Validating a session here would
 *      make every request dynamic and defeat the caching the subdomain split
 *      exists to protect. A stale or invalid cookie sending someone to
 *      `/explore` is fine — the member layout's own server-side session check
 *      handles it. Guardrail #1: the cookie's VALUE is never read, decoded or
 *      logged; only its existence.
 *
 *   2. This is ROUTING, NOT AUTHORISATION (guardrail #3). The 402
 *      subscription gate stays in the BFF. `app/(member)/**` reads Supabase
 *      directly anyway, so middleware could never have been that boundary — a
 *      presence check that looks like a gate is worse than no gate.
 */
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_NAME } from "@/lib/supabase/cookie-name";
import {
  APP_HOST,
  MARKETING_HOST,
  WWW_MARKETING_HOST,
  type UrlSpace,
  isLocalHost,
  normaliseHost,
  spaceForHost,
} from "@/lib/hosts";
import { MARKETING_IS_INDEXABLE } from "@/lib/seo";

/**
 * Both codes preserve the method (301/302 may turn a POST into a GET). The only
 * difference that matters here is cacheability, and it decides which redirects
 * a browser is allowed to pin forever.
 *
 * 308 is for a mapping that is genuinely permanent and independent of request
 * state: `www.` → apex is the only one that qualifies.
 *
 * 307 is for everything whose right answer can change — the cookie-dependent
 * root rule, and the apex catch-all (a path that is a member route TODAY may
 * become a real marketing page tomorrow; pinning it permanently would strand
 * every browser that saw the old answer).
 *
 * NOTE: the ticket's contract table writes 308 for all of these. Deviating on
 * the two state-dependent rules is deliberate — see the PR description.
 */
const PERMANENT_REDIRECT = 308;
const TEMPORARY_REDIRECT = 307;

/**
 * The public host this request arrived on.
 *
 * `x-forwarded-host` wins: a proxy in front of the app presents the real public
 * host there while `host` carries the internal one. The routing DECISION and
 * the redirect TARGET must both come from this one source — reading the
 * decision from `host` and building the URL from `nextUrl` (which Next derives
 * from `x-forwarded-host`) lets the two disagree silently. That matters
 * concretely here: the apex is still served by Wix until the DNS cutover.
 */
function requestHost(request: NextRequest): string {
  return normaliseHost(
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  );
}

/**
 * Does this request carry an auth cookie? Existence only — never the value.
 *
 * THE TRAP: `@supabase/ssr` chunks a large session across `<name>.0`,
 * `<name>.1`, … so the cookie is very often NOT present under the bare name.
 * An exact-name lookup silently fails for the majority of real members, who
 * would then be bounced to `/signin` while perfectly signed in.
 *
 * Matched as "the base name, or the base name followed by a dot" rather than a
 * loose `startsWith(AUTH_COOKIE_NAME)`: the loose form also matches
 * `<base name>-code-verifier`, the PKCE cookie that exists DURING sign-in and
 * before any session does — a false positive that would send a mid-sign-in
 * visitor to `/explore`.
 *
 * `AUTH_COOKIE_NAME` is imported, never retyped. It is the storage key both
 * Supabase clients derive every auth cookie name from; a second copy of that
 * string is a silent break waiting to happen.
 */
function hasAuthCookie(request: NextRequest): boolean {
  const chunkPrefix = `${AUTH_COOKIE_NAME}.`;
  return request.cookies
    .getAll()
    .some((cookie) => cookie.name === AUTH_COOKIE_NAME || cookie.name.startsWith(chunkPrefix));
}

/**
 * Paths that serve identically on BOTH hosts and are never redirected.
 *
 * W4 (ENG-590) owns the `/legal/[slug]` pages. This is written host-first so it
 * holds whether or not W4 has merged: middleware must never be the reason
 * `/legal/*` 404s on either host. The canonical still points at the apex — see
 * `canonicalFor()` in `lib/seo.ts`.
 */
function isSharedPath(pathname: string): boolean {
  return (
    pathname === "/legal" ||
    pathname.startsWith("/legal/") ||
    // Host-scoped by definition: an ACME HTTP-01 challenge for the apex has to
    // be answerable ON the apex. The apex is still fronted by Wix until the DNS
    // cutover, so a certificate issuance during that migration would otherwise
    // be permanently redirected away from the host being validated.
    pathname.startsWith("/.well-known/") ||
    // The ONE exception to "the BFF belongs to the app host" (ENG-726).
    //
    // The waitlist form lives on the marketing home, and a cross-origin POST to
    // the app host would be a pointless CORS preflight on the one endpoint the
    // apex genuinely owns. The 404 below exists to keep COOKIE-AUTHENTICATED
    // endpoints off a second origin; `/api/waitlist` is anonymous and reads no
    // cookie, so serving it here gives up nothing that rule protects.
    //
    // EXACT match, never a prefix: this is a hole punched in a deliberate
    // blanket 404, and `/api/waitlist/*` must not widen it. Pinned by
    // test/middleware.test.ts — `/api/waitlist` 200s on the apex and every
    // OTHER `/api/*` still 404s there.
    pathname === "/api/waitlist"
  );
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Belt and braces for the matcher below. The matcher already excludes these,
 * but this file runs on every request and a future loosening of the matcher
 * must not silently start rewriting framework assets or marketing imagery.
 *
 * Exported solely so the test can prove it agrees with `config.matcher` over a
 * corpus of paths — the two encode the same rule twice and must not diverge.
 */
export function isExcludedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/marketing/") ||
    /\.[^/]+$/.test(pathname)
  );
}

/**
 * Serve the request, tagging the response for crawlers.
 *
 * The member space is `noindex` unconditionally — it is all behind auth. The
 * marketing space follows the single `MARKETING_IS_INDEXABLE` flag. This header
 * is the third of the three noindex surfaces (robots.txt and the `<meta>` tag
 * are the other two), and the only one that covers non-HTML responses.
 */
function serve(space: UrlSpace): NextResponse {
  const response = NextResponse.next();
  if (space === "app" || !MARKETING_IS_INDEXABLE) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}

function publicUrl(request: NextRequest, host: string, pathname?: string): URL {
  const url = request.nextUrl.clone();
  url.protocol = "https:";
  url.host = host;
  // The `host` setter leaves an existing port in place; both public hosts are
  // served on 443 and a stray `:3000` would produce an unreachable Location.
  url.port = "";
  if (pathname !== undefined) url.pathname = pathname;
  return url;
}

/**
 * Same host, different path. Used only for the app-space root rule, which is
 * the ONLY redirect here whose target depends on request state.
 *
 * `no-store` + `Vary: Cookie` are load-bearing, not decoration. A bare 308 with
 * no cache directives is heuristically cacheable and browsers pin it
 * indefinitely: a signed-out visitor's `/` → `/signin` hop would be replayed
 * from the browser's own redirect cache after they signed in, so the server
 * would never see `/` again and this rule would be dead code for every
 * returning visitor.
 */
function redirectRoot(request: NextRequest, host: string, pathname: string): NextResponse {
  const response = NextResponse.redirect(
    publicUrl(request, host, pathname),
    TEMPORARY_REDIRECT,
  );
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}

/** Different host, same path and query. */
function redirectHost(
  request: NextRequest,
  from: string,
  to: string,
  status: number,
): NextResponse {
  // A host redirecting to ITSELF is always a bug and always an infinite loop.
  // `NEXT_PUBLIC_APP_HOST` and `NEXT_PUBLIC_MARKETING_HOST` are set by hand in
  // the Vercel dashboard (ENG-593), so one paste error would otherwise take
  // every member route on the apex down forever. Serve instead of looping.
  if (from === to) return serve(spaceForHost(to));

  return NextResponse.redirect(publicUrl(request, to), status);
}

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  const host = requestHost(request);

  if (isExcludedPath(pathname)) return NextResponse.next();

  // ── Decision 4: no host routing in local development ──────────────────────
  // Both spaces serve unprefixed on localhost: `/` is the marketing home,
  // `/explore` is the member app. Gating dev behind an /etc/hosts edit would
  // break every existing workflow and the Playwright harness. Nothing local is
  // reachable by a crawler, but it is tagged noindex anyway.
  if (isLocalHost(host)) return serve("app");

  // ── `www.` is not a second site ───────────────────────────────────────────
  // Path and query are preserved, so a shared `www` link still lands correctly.
  if (host === WWW_MARKETING_HOST) {
    return redirectHost(request, host, MARKETING_HOST, PERMANENT_REDIRECT);
  }

  const space = spaceForHost(host);

  // The URL spaces both hosts share — `/legal/*`, ACME, and `/api/waitlist`.
  // Checked before anything else so neither host's rules can bounce them, and
  // in particular before the marketing `/api/*` 404 below.
  if (isSharedPath(pathname)) return serve(space);

  if (space === "marketing") {
    // The BFF belongs to the app host. Serving it from the marketing origin
    // would put cookie-authenticated endpoints on a second origin for no
    // reason; 404 rather than redirect, because redirecting an API call
    // cross-origin just fails later and more confusingly.
    //
    // `/api/waitlist` is the single sanctioned exception and has already been
    // let through by `isSharedPath()` above — it is anonymous and cookie-free.
    // Nothing else may join it without the same argument.
    if (isApiPath(pathname)) return new NextResponse(null, { status: 404 });

    if (pathname === "/") return serve(space);

    // Anything else on the apex is presumed a member route: same path, app
    // host. TEMPORARY on purpose — an unknown apex path is a member route today
    // but may become a real marketing page in a later slice, and a permanent
    // redirect would strand every browser that had already seen the old answer.
    return redirectHost(request, host, APP_HOST, TEMPORARY_REDIRECT);
  }

  // ── App space: `app.stablepass.co`, plus every unknown/preview host ───────

  // THE LOOP GUARD. This rule fires on exactly `/`, on exactly the app host,
  // and nowhere else. Applied to a prefix (or to `/explore` itself) it becomes
  // `/` → `/explore` → `/`, which takes down the whole member app. Both targets
  // are real pages in the app space, so neither re-enters this branch.
  //
  // Why it is pinned to APP_HOST rather than "any app-space host": `/` is the
  // ONE path with no member route behind it (W1 deleted `app/page.tsx`), so on
  // an unknown host the only real candidate is the marketing home. Redirecting
  // it would leave the marketing site with no reachable URL at all on a preview
  // deployment — and preview URLs are the only place it can be seen until the
  // DNS cutover (ENG-593) lands. Unknown hosts still default to the app space
  // for every other path, which is what decision 3 is protecting; they just
  // serve `/` the way localhost does.
  if (pathname === "/") {
    if (host !== APP_HOST) return serve("marketing");
    return redirectRoot(request, host, hasAuthCookie(request) ? "/explore" : "/signin");
  }

  return serve(space);
}

export const config = {
  /*
   * Everything EXCEPT:
   *   `_next/*`      framework assets (static chunks, the image optimiser)
   *   `marketing/*`  the 40 extracted marketing assets under public/
   *   any path with a file extension (favicon.ico, og.jpg, robots.txt, …)
   *
   * `/api/*` is deliberately NOT excluded — the apex has to be able to refuse
   * it. Keep `isExcludedPath()` above in sync with this pattern; the test reads
   * `config.matcher` directly so the two cannot silently diverge.
   */
  matcher: ["/((?!_next/|marketing/|.*\\.[^/]+$).*)"],
};
