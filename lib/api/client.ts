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
//   2. the request went to a SAME-ORIGIN path under `/api/`, and
//   3. that path is NOT under `/api/auth/`.
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

/** Test-only: clear the latch between cases. */
export function resetEvictionLatch(): void {
  evicting = false;
}

/**
 * True only for a same-origin `/api/…` path that is not `/api/auth/…`.
 * Relative inputs are resolved against the current origin; an absolute URL on
 * any other origin is rejected.
 */
export function isMemberApiRequest(input: RequestInfo | URL): boolean {
  let path: string;
  try {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
    const url = new URL(raw, origin);
    if (typeof window !== "undefined" && url.origin !== window.location.origin) return false;
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
  if (evicting) return;
  evicting = true;
  try {
    await supabaseBrowser().auth.signOut();
  } catch {
    // A failed signOut must not strand the member on a dead screen; the cookie
    // is already invalid server-side. Fall through to the redirect regardless.
  }
  if (typeof window !== "undefined") window.location.assign(SIGNED_OUT_REDIRECT);
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
    void handleEviction();
  }
  return res;
}
