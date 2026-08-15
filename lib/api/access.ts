// The single place the entitlement rule is written in this repo.
//
// Mirrors stablepass-be `has_content_access(uid)` — keep the two in lockstep:
//   (status = 'active' and (current_period_end is null or current_period_end > now()))
//   or (status = 'trial' and trial_ends_at > now())
//
// RLS is the security boundary and this helper is the clean-402-envelope layer:
// without it an expired member gets an empty list instead of a reactivate prompt.
// Never remove the DB-side check because this one exists.
//
// HOWEVER — as of this commit the DEPLOYED `has_content_access()` is still
// status-only (`status in ('trial','active')`, schema.sql). The expiry-aware
// version above lands with stablepass-be ENG-566 on `feature/stripe-trial-v1`.
// Until that migration deploys there is NO defence in depth for expiry: this
// helper is the only thing honouring `trial_ends_at` / `current_period_end`.
// Don't read the "RLS already covers this" claim at face value before then.
export const ACCESS_COLUMNS = "status,trial_ends_at,current_period_end";

export type AccessRow = {
  status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
};

// `now` is injectable so tests are deterministic — call sites pass nothing.
// An unparseable timestamp yields NaN, every comparison is false, so it fails CLOSED.
export function hasAccess(sub: AccessRow | null, now: number = Date.now()): boolean {
  if (!sub) return false;
  if (sub.status === "active") {
    return sub.current_period_end === null || Date.parse(sub.current_period_end) > now;
  }
  if (sub.status === "trial") {
    return sub.trial_ends_at !== null && Date.parse(sub.trial_ends_at) > now;
  }
  return false;
}
