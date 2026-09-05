import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { APP_HOST, normaliseHost, spaceForHost } from "@/lib/hosts";

// POST /api/auth/forgot-password — start a password reset (ENG-953).
//
// THE ONE RULE THIS ROUTE EXISTS TO ENFORCE: **no user enumeration.** Whether
// the address has an account, has never been seen, or made Supabase itself fall
// over, this route answers the same way. An attacker holding a list of
// addresses must not learn which of them are members by diffing its answers.
// The exact bound on that claim is stated above `POST` — read it before
// changing anything here.
//
// That is why this route does NOT use `fail()` from the envelope: every early
// return would otherwise be a distinguishable signal. It always returns 200
// with the same `{ data: { sent: true } }` body, and the FE renders the same
// "check your inbox" screen off that without inspecting it.
//
// Three channels were measured and closed (review, 4 Sep):
//
//   * STATUS + BODY — identical across 13 hostile input shapes (existing,
//     unknown, malformed, empty, non-JSON, email as number/array/object/null,
//     oversized, unicode). No input reaches a 500: `req.json()` is caught and
//     every non-string `email` is rejected by the `typeof` test.
//   * TIMING — Supabase's send path is ~2.5-5x slower for a real member than
//     for an unknown address, and the two distributions did NOT overlap: one
//     request per address was enough to classify it. The response floor below
//     closes it. This is the channel a code comment previously waved away.
//   * SET-COOKIE — identical for a registered and an unregistered address (both
//     carry the PKCE verifier). See the note above `POST` for the exact bound.
//
// The residual is a member-vs-unknown gap that EXCEEDS the floor (a very slow
// SMTP provider). Raise `DEFAULT_RESPONSE_FLOOR_MS` if production telemetry
// shows the send routinely running longer than it.

// Local, deliberately permissive. A "should we bother calling Supabase" filter,
// NOT a validation gate: a value that fails it still gets the same 200 after
// the same delay. Anything stricter risks rejecting a deliverable address.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Every response takes at least this long, whatever happened inside.
 *
 * This is what makes the timing channel useless rather than merely noisy: both
 * branches are padded to the same wall-clock cost, so the fast "no such user"
 * path is indistinguishable from the slow "email sent" one.
 *
 * Deliberately NOT solved by detaching the send (`after()` / `waitUntil`),
 * which was the reviewers' first suggestion: the send is what writes the PKCE
 * verifier cookie onto THIS response, and a detached send cannot set it. That
 * would silently break the `?code=` exchange for every web-originated reset.
 *
 * `PASSWORD_RESET_FLOOR_MS` exists ONLY so the unit suite does not spend 1.5s
 * per case. It is never set in any deployed environment; if you find it set
 * outside a test runner, that is a misconfiguration reopening the timing
 * channel, not a tuning knob.
 */
const DEFAULT_RESPONSE_FLOOR_MS = 1500;

// Read per call, not once at module load: the unit suite sets the override, and
// a module-scope read is evaluated at import time — which ESM hoists ABOVE the
// test file's own statements, so the override silently never applied.
function responseFloorMs(): number {
  const override = Number(process.env.PASSWORD_RESET_FLOOR_MS);
  return Number.isFinite(override) && process.env.PASSWORD_RESET_FLOOR_MS
    ? override
    : DEFAULT_RESPONSE_FLOOR_MS;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Why the reset link's origin is not simply the request's host.
 *
 * This module NEVER trusts `x-forwarded-host` on its own. That header is attacker-supplied
 * on any request that does not pass through a trusted proxy, and this value
 * becomes the origin of a password-reset link — the classic host-header
 * injection into account takeover. The only thing standing between the raw
 * header and a poisoned link was Supabase's redirect allow-list: config in
 * ANOTHER repo, with no test here. A preview-deployment wildcard in that
 * allow-list (`https://*.vercel.app/**`, a very common entry) would have been
 * enough to make it live.
 *
 * So the header is accepted only when it names a host we already know:
 * `APP_HOST` (or the marketing apex, which `spaceForHost` recognises), or a
 * developer machine. Anything else falls back to `APP_HOST` — the member app's
 * own domain, which is where a reset link belongs.
 */

/**
 * Developer hosts, matched EXACTLY. Deliberately not `isLocalHost` from
 * `lib/hosts`, which matches the *suffixes* `.local` and `.localhost` — that is
 * right for "which URL space does this serve" routing, and catastrophic here:
 * `attacker.com/.local` ends with `.local`, so a suffix test hands an attacker
 * the origin of a password-reset link. An origin is a security decision; only
 * an exact name may produce one.
 */
const DEV_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"]);

/**
 * The port from an untrusted host header — digits only, and only when the rest
 * of the header is exactly the host we already allow-listed. The round-trip
 * comparison against `host` is what stops `::1` having its `:1` read as a port,
 * and stops anything at all being smuggled in beside the port.
 */
function devPort(raw: string, host: string): string {
  const match = /^(.+?)\.?:(\d{1,5})$/.exec(raw.trim().toLowerCase());
  if (!match || match[1] !== host) return "";
  const port = Number(match[2]);
  return port >= 1 && port <= 65535 ? `:${port}` : "";
}

/**
 * The public origin to build the reset link from.
 *
 * EVERY path through this function passes the host through an allow-list and
 * emits a scheme this function chose. Nothing derived from a header is ever
 * interpolated raw. That is the invariant; if you add a branch, it holds for
 * that branch too.
 *
 * The localhost affordance is kept (the harness and `npm run dev` serve on a
 * derived port, and a link to bare `localhost` would be unreachable) but it is
 * now (a) gated on `NODE_ENV !== "production"`, so it cannot fire on a
 * deployment at all, (b) an exact-match allow-list rather than a suffix test,
 * and (c) recomposed from the *normalised* host plus a separately validated
 * numeric port — never the raw header. Before this, the branch returned early
 * with `${proto}://${raw}` and reached neither the allow-list nor any scheme
 * check: `x-forwarded-host: attacker.com/.local` produced
 * `http://attacker.com/.local`, and `x-forwarded-proto: javascript` produced a
 * `javascript:` origin. Both were live in production.
 */
export function publicOrigin(req: Request): string {
  const raw = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const forwarded = normaliseHost(raw);

  if (process.env.NODE_ENV !== "production" && DEV_LOCAL_HOSTS.has(forwarded)) {
    // Only these two schemes may ever be produced, and only one of them here.
    const proto =
      req.headers.get("x-forwarded-proto")?.trim().toLowerCase() === "https" ? "https" : "http";
    return `${proto}://${forwarded}${devPort(raw, forwarded)}`;
  }

  // A host we recognise is honoured; anything else is discarded in favour of
  // the app's own canonical host. `https` is not negotiable off a header.
  const trusted =
    forwarded && forwarded === APP_HOST && spaceForHost(forwarded) === "app"
      ? forwarded
      : APP_HOST;

  return `https://${trusted}`;
}

// The single response. One object, one code path.
const SENT = () => NextResponse.json({ data: { sent: true } });

/**
 * What is and is not identical, stated precisely (all verified with `curl`
 * against the running app, 4 Sep — not asserted from reading the code).
 *
 * IDENTICAL for a REGISTERED vs an UNREGISTERED address — which is the entire
 * guardrail: same 200, same body bytes, same header set (both carry a
 * `…-code-verifier` cookie), same wall-clock cost. Nothing distinguishes a
 * member from a stranger.
 *
 * NOT identical: input that never reaches Supabase at all (malformed address,
 * empty body, or a request the CSRF guard refused) carries no verifier cookie,
 * because only the send emits one. That separates "syntactically an address"
 * from "not an address" — something the caller already knows about their own
 * input — and it reveals nothing about who has an account.
 *
 * An earlier draft tried to paper over this by constructing the Supabase client
 * on every path. It did not work (the cookie comes from the send, not the
 * client) and it left a comment claiming a parity the response did not have.
 * Stating the real boundary is worth more than a cosmetic one.
 */

export async function POST(req: Request) {
  // MONOTONIC, not wall-clock. `Date.now()` was wrong here twice over:
  //   * It truncates to integer ms, so two calls straddling a tick report 1ms
  //     for ~20µs of real work and the pad comes up a millisecond SHORT. That
  //     made the floor's own test fail ~20% of the time on an idle machine.
  //   * It is wall-clock, so an NTP step mid-request can make `elapsed` negative
  //     (harmless) or huge — and a huge value skips the pad entirely, silently
  //     reopening the timing channel for that request.
  // `performance.now()` is monotonic and fractional, so neither can happen.
  const startedAt = performance.now();

  // Pad, then answer. Every `return` in this function goes through here, so no
  // branch can be timed against another.
  const respond = async () => {
    const floor = responseFloorMs();
    const elapsed = performance.now() - startedAt;
    if (elapsed < floor) await sleep(floor - elapsed);
    return SENT();
  };

  // ── CSRF / login-fixation guard ──────────────────────────────────────────
  // `req.json()` parses whatever it is given, so without this a cross-origin
  // page could drive this route with a simple `<form enctype="text/plain">` —
  // no preflight, no CORS, no read of the response needed. That is not just
  // email-bombing: the forced POST plants an ATTACKER-KNOWN PKCE verifier
  // cookie in the victim's browser, after which a `?code=` link from the
  // attacker's own reset exchanges cleanly and signs the victim into the
  // ATTACKER's account (login CSRF / session fixation). `SameSite=lax` does not
  // help — it governs sending a cookie, not setting one.
  //
  // Both checks are independent of the email value, so neither reopens the
  // enumeration channel, and both run BEFORE anything touches Supabase.
  const contentType = req.headers.get("content-type") ?? "";
  const fetchSite = req.headers.get("sec-fetch-site");
  const crossSite = fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none";

  if (!contentType.toLowerCase().includes("application/json") || crossSite) {
    return respond();
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";

  if (!EMAIL_RE.test(email)) {
    return respond();
  }

  try {
    const sb = await supabaseServer();
    // The result is deliberately ignored — including the error. Supabase
    // returns a distinguishable error for rate limits and (in some versions)
    // for unknown users; surfacing either would reopen the hole this route
    // exists to close.
    await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${publicOrigin(req)}/reset-password`,
    });
  } catch {
    // Network/config failure. Still 200 — see above. This is the one place the
    // no-enumeration rule costs us observability, and it is the right trade.
  }

  return respond();
}
