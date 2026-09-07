// The marker that says "this session came from a recovery link" (ENG-953).
//
// Its own module so the route handler that SETS it and the page that REQUIRES
// it cannot drift apart on the name — the failure mode of a second copy of this
// string is that the gate silently stops gating, which is exactly the defect
// this cookie was introduced to fix.
//
// Scoped to `/reset-password` (path), so it is never sent on any other request.
export const RECOVERY_COOKIE = "sp-pw-recovery";

// Fifteen minutes: long enough to choose and type a password, short enough that
// a shared browser does not carry the permission around afterwards.
export const RECOVERY_COOKIE_MAX_AGE = 15 * 60;
