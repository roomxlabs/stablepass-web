// Central 401 handling for member BFF calls (ENG-961).
//
// WHY: single-device login (guardrail 5) revokes the previous session when the
// member signs in elsewhere. The evicted tab keeps its now-dead cookie, so every
// subsequent member fetch comes back 401 and the screen just renders an error or
// an empty state forever. There was no central handling on web at all — each
// client component called bare `fetch()`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT TRIGGERS A SIGN-OUT — deliberately narrow. ALL of these must hold:
//
//   1. status === 401, and
//   2. the body is OUR envelope with `error.code === "unauthorized"`, and
//   3. the request went to a SAME-ORIGIN path under `/api/`, and
//   4. that path is NOT under `/api/auth/`, and
//   5. a deliberate sign-out is not already in progress.
//
// Requiring the envelope code, not just the status, is what keeps this honest as
// routes are added: a future `/api/*` route that 401s for some non-session
// reason will not carry `unauthorized`, and an unparseable/foreign 401 body
// fails CLOSED (no sign-out). It also removes any need to reason about a 401
// arriving from a redirect to another origin — that response is not our
// envelope.
//
// WHAT DOES NOT (each pinned by a test in test/api-client.test.ts):
//
//   - **402 `subscription_required`** — the content gate (guardrail 3). A lapsed
//     member is still SIGNED IN and must see the reactivate wall. Signing them
//     out here would be a straight guardrail violation, and it is the single
//     most likely way this change could go wrong.
//   - **403 / 404 / 429 / 5xx** — nothing about the session.
//   - **A 401 from a THIRD-PARTY origin** (Stripe, Mux, Supabase storage, any
//     absolute URL). Only same-origin `/api/*` is ours to interpret; a 401 from
//     someone else's API says nothing about our cookie.
//   - **A 401 from `/api/auth/*`** — those routes serve the SIGNED-OUT flows
//     (signup, forgot-password) and `/api/auth/bootstrap`. Treating them as an
//     eviction risks a redirect loop on the very pages a signed-out visitor is
//     supposed to be on.
//
// Every 401 under `app/api/*` today is `UNAUTH()` from lib/api/envelope.ts,
// emitted only by an `if (!user)` guard — there is no route that 401s for a
// non-session reason. That is what makes status alone a safe signal here; the
// exclusions above are the belt to keep it true as routes are added.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseBrowser } from "@/lib/supabase/client";
import { SIGNED_OUT_REDIRECT } from "@/lib/api/signed-out";

export { SIGNED_OUT_ELSEWHERE, SIGNED_OUT_REDIRECT } from "@/lib/api/signed-out";

// One eviction, one redirect. A screen typically has several member calls in
// flight at once (feed + media + unread-count), so without this latch an
// eviction fires N concurrent sign-outs and N navigations.
let evicting = false;

/** How long we wait for the local session clear before redirecting anyway. */
const SIGN_OUT_TIMEOUT_MS = 3000;

// Set while the member is signing out ON PURPOSE. Any `apiFetch` still in flight
// at that moment (the sidebar unread poll, a fire-and-forget read receipt) lands
// after the session is gone and comes back 401 — without this, a deliberate
// "Sign out" click would redirect to `?reason=signed-out-elsewhere` and tell the
// member their account was used on another device, which is simply false and
// reads as a security alert.
let suppressed = false;

/** Call FIRST in a deliberate sign-out handler, before clearing the session. */
export function suppressEviction(): void {
  suppressed = true;
}

/** Test-only: clear the latch/suppression between cases. */
export function resetEvictionLatch(): void {
  evicting = false;
  suppressed = false;
}

/**
 * True only for a same-origin `/api/…` path that is not `/api/auth/…`.
 * Relative inputs are resolved against the current origin; an absolute URL on
 * any other origin is rejected.
 */
export function isMemberApiRequest(input: RequestInfo | URL): boolean {
  // Eviction is a browser-only concept. Bailing here also stops the module-level
  // `evicting` latch from ever being set in the shared Node server process,
  // where it would silently disable 401 handling for every member on that
  // instance.
  if (typeof window === "undefined") return false;
  let path: string;
  try {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return false;
    path = url.pathname;
  } catch {
    return false;
  }
  if (!path.startsWith("/api/")) return false;
  if (path.startsWith("/api/auth/")) return false;
  return true;
}

/**
 * Clear the dead session and send the member to sign in with an explanation.
 *
 * The session MUST be cleared before navigating: `/signin` redirects anyone with
 * a live session straight back to `/explore`, so skipping the signOut would
 * bounce the member into a loop instead of showing the message.
 *
 * A full-page assignment (not router.push) is deliberate — it drops all client
 * state held by the evicted screens rather than re-rendering them against a
 * session that no longer exists.
 */
async function handleEviction(): Promise<void> {
  if (evicting || suppressed) return;
  evicting = true;
  try {
    // `scope: "local"` clears THIS browser only. The default is "global", which
    // would revoke the member's sessions on every other device — so a single
    // spurious 401 here (a transient GoTrue blip on the BFF is indistinguishable
    // from a dead session) would log them out of their phone too, irreversibly.
    // We are REACTING to an eviction, not performing one. Same scope the
    // password-reset route uses (app/reset-password/confirm/route.ts).
    //
    // Raced against a timer: auth-js has no request timeout, and a signOut that
    // HANGS (rather than rejects) would otherwise leave the member on a dead
    // screen forever with the latch set, swallowing every later 401.
    await Promise.race([
      supabaseBrowser().auth.signOut({ scope: "local" }),
      new Promise((resolve) => setTimeout(resolve, SIGN_OUT_TIMEOUT_MS)),
    ]);
  } catch {
    // A failed signOut must not strand the member on a dead screen; the cookie
    // is already invalid server-side. Redirect regardless — see `finally`.
  } finally {
    // In `finally` so a throw OR a hang still lands the member on /signin.
    window.location.assign(SIGNED_OUT_REDIRECT);
  }
}

/**
 * `fetch` for member BFF calls. Identical semantics to `fetch` — same arguments,
 * the same Response is returned untouched — plus the central 401 handling above.
 * Callers keep their existing status handling (notably the 402 → AccessWall
 * branches), which is why this returns the response rather than throwing.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Forward the ORIGINAL argument shape. Passing an explicit `undefined` second
  // argument is observably different (`fetch.mock.calls` records two args), and
  // it broke a pre-existing test that asserts the exact call. A drop-in wrapper
  // must be indistinguishable from `fetch` at the call site.
  const res = init === undefined ? await fetch(input) : await fetch(input, init);
  if (res.status === 401 && isMemberApiRequest(input)) {
    // `clone()` so the caller still gets an unread body — this wrapper must stay
    // invisible to every existing call site.
    void isUnauthorizedEnvelope(res.clone()).then((yes) => {
      if (yes) void handleEviction();
    });
  }
  return res;
}

/**
 * Is this our `UNAUTH()` envelope (`lib/api/envelope.ts`) — `error.code ===
 * "unauthorized"` — rather than some other 401? Fails CLOSED: anything we cannot
 * parse as that exact shape returns false and does NOT sign the member out.
 */
async function isUnauthorizedEnvelope(res: Response): Promise<boolean> {
  try {
    const body = await res.json();
    return body?.error?.code === "unauthorized";
  } catch {
    return false;
  }
}
