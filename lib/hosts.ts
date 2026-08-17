/**
 * Host → URL space (ENG-591 / W5).
 *
 * One Next app, one Vercel project, two domains: the apex serves the
 * `(marketing)` space and `app.` serves the member space. This module is the
 * single place that knows which host means which, so `middleware.ts`,
 * `app/robots.ts` and the SEO helpers can never drift apart.
 *
 * Host names are `NEXT_PUBLIC_*` on purpose (guardrail #9): a domain name is
 * public information, and middleware needs them inlined at build time. Nothing
 * secret belongs in this file.
 */

/**
 * The marketing apex. Also the canonical origin — `www.` 308s to it rather than
 * serving a duplicate of every page.
 */
/**
 * `??` is not enough: an env var present-but-blank in the Vercel dashboard is a
 * common misconfiguration, and `"" ?? default` is `""`. Treat blank as unset.
 */
function hostFromEnv(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : fallback;
}

export const MARKETING_HOST = hostFromEnv(
  process.env.NEXT_PUBLIC_MARKETING_HOST,
  "stablepass.co",
)
  // Always the BARE apex. Accepting a `www.` value would make the canonical
  // `www.`, and would derive `www.www.…` as the redirect source below —
  // silently disabling the www rule instead of failing visibly.
  .replace(/^www\./, "");

/** The member app host. Everything behind auth lives here. */
export const APP_HOST = hostFromEnv(process.env.NEXT_PUBLIC_APP_HOST, "app.stablepass.co");

/** `www.<apex>` — served only long enough to redirect to the bare apex. */
export const WWW_MARKETING_HOST = `www.${MARKETING_HOST}`;

export type UrlSpace = "marketing" | "app";

/**
 * Hosts that mean "this is a developer's machine". Decision 4: local
 * development does NOT do host routing, so both spaces serve unprefixed and
 * every existing workflow — including the Playwright harness, which drives
 * `http://localhost:3000` — keeps working with no `/etc/hosts` edit.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

const PORT_SUFFIX = /^(.*):\d+$/;

/**
 * Normalise a `Host` header for comparison.
 *
 * The header arrives with arbitrary case, usually a port in development, and
 * occasionally the fully-qualified root dot (`stablepass.co.`). All three are
 * the same host and must compare equal, or a capitalised `Host` silently falls
 * through to the unknown-host default.
 */
export function normaliseHost(hostHeader: string | null | undefined): string {
  if (!hostHeader) return "";
  let host = hostHeader.trim().toLowerCase();

  if (host.startsWith("[")) {
    // An IPv6 literal is bracketed (`[::1]:3000`). Cut at the bracket so the
    // colons inside the address survive the port strip.
    const close = host.indexOf("]");
    if (close !== -1) host = host.slice(0, close + 1);
  } else {
    // Only strip a trailing `:digits` when what precedes it holds no colon of
    // its own. Otherwise a bare, unbracketed `::1` has its `:1` read as a port
    // and normalises to `:`, which matches nothing.
    const withPort = host.match(PORT_SUFFIX);
    if (withPort && !withPort[1].includes(":")) host = withPort[1];
  }

  return host.endsWith(".") ? host.slice(0, -1) : host;
}

/** True for a developer machine — see `LOCAL_HOSTS` and decision 4. */
export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local");
}

/**
 * Which URL space a host serves.
 *
 * Only the apex and its `www.` alias are marketing. EVERYTHING else is the app
 * space — the app host, Vercel preview URLs (`*.vercel.app`), the raw
 * deployment domain, an alias nobody has configured yet.
 *
 * Defaulting the unknown host to the app space is deliberate: it must not 404
 * the world. Preview deployments are how these PRs get reviewed, and a preview
 * host that resolved to "marketing" would 404 every member route on it.
 */
export function spaceForHost(host: string): UrlSpace {
  if (host === MARKETING_HOST || host === WWW_MARKETING_HOST) return "marketing";
  return "app";
}
