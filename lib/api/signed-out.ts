// The eviction contract, shared by the client fetch wrapper that DETECTS a dead
// session (lib/api/client.ts) and the server-rendered sign-in page that
// EXPLAINS it (app/signin/page.tsx).
//
// It lives in its own module on purpose: app/signin/page.tsx is a server
// component, and importing these constants from lib/api/client.ts would drag
// the browser Supabase client into the server bundle for the sake of one string.

/** `?reason=` value set when a member's session was revoked by a sign-in elsewhere. */
export const SIGNED_OUT_ELSEWHERE = "signed-out-elsewhere";

/** Where an evicted member is sent. */
export const SIGNED_OUT_REDIRECT = `/signin?reason=${SIGNED_OUT_ELSEWHERE}`;

/**
 * Copy for a `?reason=` on /signin.
 *
 * Allow-list, not a passthrough: only reasons WE emit render anything. An
 * unknown, absent or array-valued `reason` yields null, so the query string can
 * never be used to plant arbitrary text on the sign-in page.
 */
export function noticeForReason(
  reason: string | string[] | undefined | null,
): string | null {
  if (typeof reason !== "string") return null;
  if (reason === SIGNED_OUT_ELSEWHERE) {
    return "You were signed out because your account was signed in on another device. Sign in again to continue.";
  }
  return null;
}
