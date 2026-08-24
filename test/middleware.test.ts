// @vitest-environment node
//
// Middleware is server code and constructs real Request/Response objects, so it
// runs in the node environment rather than the suite's default jsdom.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { middleware, config, isExcludedPath } from "@/middleware";
import { AUTH_COOKIE_NAME } from "@/lib/supabase/cookie-name";

const MARKETING = "stablepass.co";
const WWW = "www.stablepass.co";
const APP = "app.stablepass.co";
const PREVIEW = "stablepass-web-git-eng-591.vercel.app";

type Call = {
  host: string;
  path?: string;
  search?: string;
  cookies?: string[];
  forwardedHost?: string;
};

function build({ host, path = "/", search = "", cookies = [], forwardedHost }: Call): NextRequest {
  const scheme = host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
  const headers = new Headers({ host });
  if (forwardedHost) headers.set("x-forwarded-host", forwardedHost);
  if (cookies.length) {
    // The value is irrelevant by design — middleware never reads it.
    headers.set("cookie", cookies.map((name) => `${name}=irrelevant`).join("; "));
  }
  return new NextRequest(`${scheme}://${host}${path}${search}`, { headers });
}

function run(call: Call) {
  const response = middleware(build(call));
  return {
    status: response.status,
    location: response.headers.get("location"),
    robots: response.headers.get("x-robots-tag"),
    cacheControl: response.headers.get("cache-control"),
    vary: response.headers.get("vary"),
  };
}

const SIGNED_IN = [AUTH_COOKIE_NAME];
const CHUNKED = [`${AUTH_COOKIE_NAME}.0`, `${AUTH_COOKIE_NAME}.1`];

describe("host routing — the contract table", () => {
  it("serves the marketing home on the apex", () => {
    const { status, location } = run({ host: MARKETING, path: "/" });
    expect(status).toBe(200);
    expect(location).toBeNull();
  });

  it("308s www to the bare apex, preserving path and query", () => {
    expect(run({ host: WWW, path: "/", search: "" }).location).toBe(`https://${MARKETING}/`);
    expect(run({ host: WWW, path: "/legal/privacy", search: "?ref=email" }).location).toBe(
      `https://${MARKETING}/legal/privacy?ref=email`,
    );
    expect(run({ host: WWW, path: "/" }).status).toBe(308);
  });

  it("serves /legal/* on the apex", () => {
    expect(run({ host: MARKETING, path: "/legal/privacy" }).status).toBe(200);
  });

  it("redirects a member route requested on the apex to the app host", () => {
    const { status, location } = run({ host: MARKETING, path: "/explore" });
    expect(status).toBe(307);
    expect(location).toBe(`https://${APP}/explore`);
  });

  it("redirects the app host root to /explore when an auth cookie is present", () => {
    const { status, location } = run({ host: APP, path: "/", cookies: SIGNED_IN });
    expect(status).toBe(307);
    expect(location).toBe(`https://${APP}/explore`);
  });

  it("redirects the app host root to /signin when there is no auth cookie", () => {
    const { status, location } = run({ host: APP, path: "/" });
    expect(status).toBe(307);
    expect(location).toBe(`https://${APP}/signin`);
  });

  // NB: a 200 here means "middleware passed the request through untouched" —
  // NextResponse.next() is always 200. It deliberately does NOT assert the route
  // exists (some, like /legal/*, are W4's and not merged yet). What is under
  // test is that middleware neither redirects nor blocks these paths.
  it("passes the member app, legal and signup through on the app host", () => {
    for (const path of ["/explore", "/legal/privacy", "/start", "/signin", "/account"]) {
      const { status, location } = run({ host: APP, path });
      expect(status, path).toBe(200);
      expect(location, path).toBeNull();
    }
  });

  it("does not let a browser cache the cookie-dependent root redirect", () => {
    // A bare 308 is heuristically cacheable and browsers pin it indefinitely,
    // so a signed-out visitor's / -> /signin hop would be replayed from cache
    // after they sign in and this rule would never run again.
    const { cacheControl, vary } = run({ host: APP, path: "/" });
    expect(cacheControl).toBe("no-store");
    expect(vary).toBe("Cookie");
  });

  it("keeps the state-independent host redirects cacheable", () => {
    expect(run({ host: WWW, path: "/" }).cacheControl).toBeNull();
    expect(run({ host: MARKETING, path: "/explore" }).cacheControl).toBeNull();
  });
});

describe("a host never redirects to itself", () => {
  // NEXT_PUBLIC_APP_HOST and NEXT_PUBLIC_MARKETING_HOST are set by hand in the
  // Vercel dashboard (ENG-593). If one is pasted wrong so the two hosts match,
  // an unguarded cross-host redirect loops every member route on the apex
  // forever. The guard serves the request instead.
  it("serves rather than loops when the two hosts are misconfigured to match", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_APP_HOST", "stablepass.co");
    vi.stubEnv("NEXT_PUBLIC_MARKETING_HOST", "stablepass.co");

    const { middleware: mw } = await import("@/middleware");
    const response = mw(build({ host: "stablepass.co", path: "/explore" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();

    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe("the public host comes from one source", () => {
  // Behind a proxy the real public host is in x-forwarded-host while `host`
  // carries the internal one. Deciding from one and building the redirect from
  // the other lets them disagree silently — and the apex is still fronted by
  // Wix until the DNS cutover.
  it("routes on x-forwarded-host when a proxy sets it", () => {
    const { status, location } = run({
      host: "internal.vercel.internal",
      forwardedHost: MARKETING,
      path: "/explore",
    });
    expect(status).toBe(307);
    expect(location).toBe(`https://${APP}/explore`);
  });

  it("serves the marketing home when the proxy presents the apex", () => {
    expect(run({ host: "internal.vercel.internal", forwardedHost: MARKETING, path: "/" }).status)
      .toBe(200);
  });

  it("still redirects the app-host root correctly behind a proxy", () => {
    expect(
      run({ host: "internal.vercel.internal", forwardedHost: APP, path: "/" }).location,
    ).toBe(`https://${APP}/signin`);
  });
});

describe("the chunked auth cookie — decision 2, the trap", () => {
  it("detects a session chunked across .0 and .1", () => {
    expect(run({ host: APP, path: "/", cookies: CHUNKED }).location).toBe(`https://${APP}/explore`);
  });

  it("detects a chunked session even when only .0 is present", () => {
    expect(run({ host: APP, path: "/", cookies: [`${AUTH_COOKIE_NAME}.0`] }).location).toBe(
      `https://${APP}/explore`,
    );
  });

  it("detects the unchunked cookie too", () => {
    expect(run({ host: APP, path: "/", cookies: SIGNED_IN }).location).toBe(`https://${APP}/explore`);
  });

  it("does NOT treat the PKCE code-verifier as a session", () => {
    // This cookie exists DURING sign-in, before any session does. A loose
    // startsWith() match would send a mid-sign-in visitor to /explore.
    const { location } = run({
      host: APP,
      path: "/",
      cookies: [`${AUTH_COOKIE_NAME}-code-verifier`],
    });
    expect(location).toBe(`https://${APP}/signin`);
  });

  it("ignores an unrelated app's cookie", () => {
    const { location } = run({ host: APP, path: "/", cookies: ["sb-stablepass-admin-auth"] });
    expect(location).toBe(`https://${APP}/signin`);
  });
});

describe("no redirect loop within middleware — chain followed to completion", () => {
  // Feeds each Location back through middleware until it stops redirecting.
  // A loop exhausts the budget and throws with the chain that caused it.
  //
  // Scope, stated honestly: this follows MIDDLEWARE hops only. A settled
  // "status 200" means middleware returned next(), not that the app came to
  // rest — Next's own URL normalisation and the layouts' redirect() calls are
  // not in this loop. Those were verified against the running app during
  // review (every host settles in <= 2 hops, including the stale-cookie case
  // `/` -> `/explore` -> `/signin`); what is regression-locked here is that
  // middleware alone can never cycle.
  function follow(start: Call, budget = 10) {
    const chain: string[] = [];
    let current: Call = { ...start };

    for (let hop = 0; hop < budget; hop++) {
      const response = middleware(build(current));
      if (response.status !== 307 && response.status !== 308) {
        return { chain, status: response.status };
      }
      const location = response.headers.get("location");
      expect(location, "a redirect with no Location").not.toBeNull();
      chain.push(location!);
      const url = new URL(location!);
      current = { ...current, host: url.host, path: url.pathname, search: url.search };
    }

    throw new Error(`redirect loop: ${[start.path, ...chain].join(" -> ")}`);
  }

  it("settles the app-host root for a signed-in member", () => {
    const { chain, status } = follow({ host: APP, path: "/", cookies: SIGNED_IN });
    expect(chain).toEqual([`https://${APP}/explore`]);
    expect(status).toBe(200);
  });

  it("settles the app-host root for a signed-out visitor", () => {
    const { chain, status } = follow({ host: APP, path: "/" });
    expect(chain).toEqual([`https://${APP}/signin`]);
    expect(status).toBe(200);
  });

  it("settles www, the apex, cross-host member routes and preview hosts", () => {
    const starts: Call[] = [
      { host: WWW, path: "/" },
      { host: WWW, path: "/explore", cookies: SIGNED_IN },
      { host: MARKETING, path: "/" },
      { host: MARKETING, path: "/explore" },
      { host: MARKETING, path: "/legal/terms" },
      { host: APP, path: "/legal/terms" },
      { host: APP, path: "/explore", cookies: CHUNKED },
      { host: PREVIEW, path: "/", cookies: CHUNKED },
      { host: PREVIEW, path: "/explore" },
      { host: "localhost:3000", path: "/" },
      { host: "localhost:3000", path: "/explore" },
    ];
    for (const start of starts) {
      const { status } = follow(start);
      expect(status, `${start.host}${start.path}`).toBe(200);
    }
  });

  it("never fires the root rule on a path that merely starts with /", () => {
    // The failure mode being guarded: applying the root rule to a prefix turns
    // / -> /explore -> / into an infinite bounce.
    for (const path of ["/explore", "/signin", "/saved", "/following", "/horses/abc"]) {
      expect(run({ host: APP, path }).status, path).toBe(200);
    }
  });
});

describe("local development does no host routing — decision 4", () => {
  it("serves both spaces unprefixed on localhost", () => {
    for (const host of ["localhost:3000", "localhost", "127.0.0.1:3000", "[::1]:3000"]) {
      expect(run({ host, path: "/" }).status, `${host}/`).toBe(200);
      expect(run({ host, path: "/explore" }).status, `${host}/explore`).toBe(200);
      expect(run({ host, path: "/legal/privacy" }).status, `${host}/legal`).toBe(200);
    }
  });

  it("does not redirect the localhost root even with a session cookie", () => {
    // The Playwright harness drives localhost:3000 and asserts / is the
    // marketing home at status 200.
    const { status, location } = run({ host: "localhost:3000", path: "/", cookies: CHUNKED });
    expect(status).toBe(200);
    expect(location).toBeNull();
  });

  it("serves /api on localhost", () => {
    expect(run({ host: "localhost:3000", path: "/api/me" }).status).toBe(200);
  });
});

describe("unknown hosts default to the app space", () => {
  it("does not 404 a preview deployment", () => {
    expect(run({ host: PREVIEW, path: "/explore" }).status).toBe(200);
    expect(run({ host: PREVIEW, path: "/legal/privacy" }).status).toBe(200);
    expect(run({ host: PREVIEW, path: "/api/me" }).status).toBe(200);
  });

  it("keeps the marketing home reachable on a preview host", () => {
    // `/` is the ONLY marketing route (W1 deleted app/page.tsx and the nav is
    // anchor-only), so redirecting it away leaves the marketing site with no
    // reachable URL at all on a preview deployment — while a preview URL is the
    // only place it can be seen until the DNS cutover lands. Serve it, exactly
    // as localhost does.
    for (const cookies of [[], CHUNKED]) {
      const { status, location } = run({ host: PREVIEW, path: "/", cookies });
      expect(status).toBe(200);
      expect(location).toBeNull();
    }
  });

  it("never bounces a preview host to production", () => {
    // Bouncing a reviewer from the preview URL to production would make the
    // deployment unreviewable, which is the whole point of preview URLs.
    for (const path of ["/", "/explore", "/legal/privacy", "/api/me", "/start"]) {
      const { location } = run({ host: PREVIEW, path });
      if (location) expect(new URL(location).host, path).toBe(PREVIEW);
    }
  });
});

describe("host header normalisation", () => {
  it("treats case, port and the fully-qualified root dot as the same host", () => {
    for (const host of ["STABLEPASS.CO", "stablepass.co.", "StablePass.Co"]) {
      expect(run({ host, path: "/" }).status, host).toBe(200);
      expect(run({ host, path: "/explore" }).location, host).toBe(`https://${APP}/explore`);
    }
  });

  it("strips a port from a cross-host redirect Location", () => {
    expect(run({ host: "stablepass.co:443", path: "/explore" }).location).toBe(
      `https://${APP}/explore`,
    );
  });
});

describe("the BFF belongs to the app host", () => {
  it("404s /api/* on the marketing apex", () => {
    expect(run({ host: MARKETING, path: "/api/me" }).status).toBe(404);
    expect(run({ host: WWW, path: "/api/me" }).status).toBe(308);
  });

  it("serves /api/* on the app host", () => {
    expect(run({ host: APP, path: "/api/me" }).status).toBe(200);
  });

  // ENG-726 — /api/waitlist is the ONE sanctioned exception to the blanket
  // marketing-apex 404 above: it is anonymous, cookie-free, and lives on the
  // marketing home, so a cross-origin POST to the app host would be a pointless
  // CORS preflight for no security benefit. See isSharedPath() in middleware.ts.
  it("serves /api/waitlist on the marketing apex", () => {
    const { status, location } = run({ host: MARKETING, path: "/api/waitlist" });
    expect(status).toBe(200);
    expect(location).toBeNull();
  });

  it("404s every other DOTLESS /api/* on the marketing apex", () => {
    const paths = [
      "/api/me",
      "/api/feed",
      "/api/auth/signup",
      "/api/subscription/checkout",
      "/api/posts/abc/playback",
      "/api/trainers/abc",
      "/api/horses/abc",
      "/api",
    ];
    for (const path of paths) {
      expect(run({ host: MARKETING, path }).status, path).toBe(404);
    }
  });

  // ENG-773 — THE FLIP. This test used to pin the gap as current behaviour
  // (`isExcludedPath` true, middleware passing the request through with a 200);
  // it now pins the fix. Both halves had to change to get here: the `/api`
  // entry in `config.matcher` gets middleware INVOKED for a dotted API path,
  // and the `isApiPath()` bail-out in `isExcludedPath()` stops it returning
  // `next()` on middleware()'s first line. Patching either alone is a no-op —
  // an earlier attempt patched only the guard and measured 401 -> 401.
  //
  // Flipped only AFTER the served behaviour was measured to change on the
  // built server, never before: a green unit assertion of containment while
  // production still answered 401 would be the exact disease this ticket cures.
  //
  //   Host: stablepass.co, built server, GET /api/trainers/abc.json
  //     before: 401 {"error":{"code":"unauthorized",...}}  (handler executed)
  //     after:  404 (0 bytes)                              (middleware refused)
  it("contains /api/* whose last segment has a dot — ENG-773, was a known gap", () => {
    const paths = ["/api/trainers/abc.json", "/api/horses/abc.json", "/api/me.json"];
    for (const path of paths) {
      // No longer excluded, so middleware actually reaches its verdict.
      expect(isExcludedPath(path), path).toBe(false);
      expect(run({ host: MARKETING, path }).status, path).toBe(404);
    }
  });

  // The dotted paths are only dangerous where a DYNAMIC segment captures them:
  // `/api/trainers/[id]` and `/api/horses/[id]` resolve `abc.json` as an id and
  // used to execute on the apex. Pin the dynamic-route shape explicitly so a
  // future route added under a `[param]` inherits the containment.
  it("404s a dotted id on every dynamic /api route on the marketing apex", () => {
    const paths = [
      "/api/trainers/abc.json",
      "/api/horses/abc.json",
      "/api/trainers/abc.json/feed",
      "/api/horses/abc.json/feed",
      "/api/posts/abc.json/playback",
      "/api/trainers/abc.json/website-click",
      "/api/feed.json",
      "/api/auth/signup.json",
    ];
    for (const path of paths) {
      expect(run({ host: MARKETING, path }).status, path).toBe(404);
    }
  });

  // Those same dotted paths must still be SERVED on the app host — the fix
  // contains them on the marketing origin, it does not break the BFF.
  it("still serves dotted /api/* on the app host", () => {
    for (const path of ["/api/trainers/abc.json", "/api/horses/abc.json"]) {
      expect(run({ host: APP, path }).status, path).toBe(200);
    }
  });

  // This is a hole deliberately punched in a blanket 404 — EXACT match only.
  // Widening it to a prefix would put every future /api/waitlist/* endpoint on
  // the apex without anyone deciding that, the same way /api/waitlist itself
  // was deliberately decided.
  it("shares only the exact /api/waitlist path, never a prefix", () => {
    const paths = ["/api/waitlist/anything", "/api/waitlist/", "/api/waitlistx", "/api/waitlist-admin"];
    for (const path of paths) {
      expect(run({ host: MARKETING, path }).status, path).toBe(404);
    }
  });

  it("serves /api/waitlist on the app host too", () => {
    expect(run({ host: APP, path: "/api/waitlist" }).status).toBe(200);
  });

  // `isSharedPath()` is checked AFTER the `www` -> apex redirect in
  // middleware(), not before it, so www does not get a shared-path bypass —
  // it still 308s to the apex first, exactly as /api/me does above. Whatever
  // arrives at the apex from that redirect is a separate, later request that
  // isSharedPath() sees for itself.
  it("does not redirect /api/waitlist from www — it 308s to the apex first, same as any other path", () => {
    const { status, location } = run({ host: WWW, path: "/api/waitlist" });
    expect(status).toBe(308);
    expect(location).toBe(`https://${MARKETING}/api/waitlist`);
  });
});

describe("robots headers", () => {
  it("always noindexes the member space", () => {
    expect(run({ host: APP, path: "/explore" }).robots).toBe("noindex, nofollow");
    expect(run({ host: APP, path: "/legal/privacy" }).robots).toBe("noindex, nofollow");
  });

  it("noindexes marketing while MARKETING_IS_INDEXABLE is false", () => {
    expect(run({ host: MARKETING, path: "/" }).robots).toBe("noindex, nofollow");
  });
});

describe("the matcher", () => {
  // Built from config.matcher itself so the assertion cannot drift from the
  // patterns Next actually compiles.
  //
  // ENG-773 made this a MULTI-ELEMENT matcher, and Next invokes middleware if
  // ANY entry matches — so every check below is a union over all entries, not
  // `matcher[0]`. This used to read index 0 and would therefore have gone on
  // passing while silently ignoring the entry that carries the fix; an
  // assertion that checks only the first of two entries is a guard that has
  // stopped guarding.
  const patterns = config.matcher as string[];
  const matchesAny = (pathname: string) =>
    patterns.some((pattern) => new RegExp(`^${pattern}$`).test(pathname));

  it("is a union — every entry is a compilable regex and all of them are checked", () => {
    // Guards the helper above rather than the middleware: if someone adds a
    // third entry in path-to-regexp sugar (`/api/:path*`), `new RegExp` would
    // read `:path*` as a literal `:pat` + `h*` and quietly match nothing, and
    // every agreement assertion below would go vacuously green.
    expect(patterns.length).toBeGreaterThan(1);
    for (const pattern of patterns) {
      expect(() => new RegExp(`^${pattern}$`), pattern).not.toThrow();
      expect(pattern.startsWith("/"), pattern).toBe(true);
      expect(pattern, pattern).not.toContain(":");
    }
  });

  // DECISION 6 (ENG-773): the matcher now admits paths it previously skipped,
  // so prove the carve-out that the dot rule exists for is still intact. These
  // must be matched by NEITHER entry — breaking asset bypass to fix /api/*
  // would be a bad trade.
  it("still excludes framework assets and marketing imagery — no collateral routing change", () => {
    for (const path of [
      "/_next/static/chunks/main.js",
      "/_next/image",
      "/marketing/hero.jpg",
      "/marketing/trainers/abc.webp",
      "/favicon.ico",
      "/og.jpg",
      "/robots.txt",
      "/apple-touch-icon.png",
      "/sitemap.xml",
    ]) {
      expect(matchesAny(path), path).toBe(false);
    }
  });

  it("includes the routes middleware has to decide", () => {
    for (const path of ["/", "/explore", "/signin", "/start", "/legal/privacy", "/api/me"]) {
      expect(matchesAny(path), path).toBe(true);
    }
  });

  // The point of the whole ticket: these are matched ONLY by the `/api` entry.
  it("includes dotted /api/* — the entry ENG-773 added", () => {
    for (const path of ["/api/trainers/abc.json", "/api/horses/abc.json", "/api/me.json"]) {
      expect(matchesAny(path), path).toBe(true);
      // Specifically: entry [0] still rejects them (its dot rule is untouched),
      // so the union is doing the work and entry [0] was not re-scoped.
      expect(new RegExp(`^${patterns[0]}$`).test(path), path).toBe(false);
    }
  });

  it("does not widen beyond /api — `/apifoo` is not an API path", () => {
    // `/(api|api/.*)` must mean exactly `isApiPath()`. A sloppier `/api(.*)`
    // would swallow `/apifoo.json` and break agreement with the guard.
    expect(matchesAny("/apifoo.json")).toBe(false);
    expect(matchesAny("/api")).toBe(true);
    expect(matchesAny("/api/")).toBe(true);
  });

  it("agrees with the in-function guard on every path", () => {
    // The exclusion rule is encoded twice — once as the matcher Next compiles,
    // once as isExcludedPath(), which is the first thing middleware() consults.
    // They must not drift: if the matcher admits a path the guard excludes,
    // middleware is invoked only to immediately return next(), which is exactly
    // how the ENG-773 gap survived a "fix" that touched only one of them.
    const corpus = [
      "/",
      "/explore",
      "/signin",
      "/start",
      "/account",
      "/legal",
      "/legal/privacy",
      "/api",
      "/api/me",
      "/api/waitlist",
      "/api/subscription/cancel",
      // ENG-773 — the paths the gap was found on.
      "/api/trainers/abc.json",
      "/api/horses/abc.json",
      "/api/me.json",
      "/auth/callback",
      "/onboarding",
      "/horses/9f1c2b3a-0000-4444-8888-abcdefabcdef",
      "/.well-known/acme-challenge/tok123",
      "/_next/static/chunks/main.js",
      "/marketing/hero.jpg",
      "/favicon.ico",
      "/og.jpg",
      "/robots.txt",
      "/some.thing",
      "/apifoo.json",
    ];
    for (const path of corpus) {
      expect(isExcludedPath(path), path).toBe(!matchesAny(path));
    }
  });
});

describe("host-scoped well-known paths serve on both hosts", () => {
  it("never redirects an ACME challenge away from the host being validated", () => {
    // The apex is still fronted by Wix until the DNS cutover; a certificate
    // issued during that migration must be answerable ON the apex.
    for (const host of [MARKETING, APP, PREVIEW]) {
      const { status, location } = run({ host, path: "/.well-known/acme-challenge/tok123" });
      expect(status, host).toBe(200);
      expect(location, host).toBeNull();
    }
  });
});

describe("guardrails", () => {
  const source = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");

  it("makes no Supabase call and no network round-trip", () => {
    // Guardrail #1 + decision 1: presence check only.
    expect(source).not.toMatch(/lib\/supabase\/server/);
    expect(source).not.toMatch(/supabaseServer|createServerClient|createBrowserClient/);
    expect(source).not.toMatch(/getUser|getSession/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/\bawait\b/);
    expect(source).not.toMatch(/\basync\b/);
  });

  it("imports the cookie name instead of retyping it", () => {
    // Decision 2: a second copy of this string is a silent break waiting to
    // happen, and retyping it is how the prefix check gets written wrong.
    expect(source).toContain('from "@/lib/supabase/cookie-name"');
    expect(source).not.toContain(AUTH_COOKIE_NAME);
  });

  it("never reads or logs a cookie value", () => {
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/cookie\.value|\.get\(AUTH_COOKIE_NAME\)/);
  });
});
