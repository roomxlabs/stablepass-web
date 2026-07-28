// The storage key @supabase/ssr derives every auth cookie name from.
//
// Why this is pinned instead of left to the default: the default is
// `sb-<project-ref>-auth-token`, which depends ONLY on the Supabase project.
// stablepass-web and stablepass-admin talk to the SAME project, and cookies are
// scoped by domain, NOT by port — so on `localhost` the member app (:3000) and
// the admin dashboard (:3002) were reading and overwriting each other's session.
// Signing into admin silently swapped the member session for the admin one.
//
// A distinct, audience-specific name gives the two apps independent sessions on
// a shared host. Mirrors the sibling portals, which likewise namespace their
// cookies per audience rather than per project.
//
// Both clients MUST use this one constant: @supabase/ssr passes it through as
// `storageKey`, and a server/browser mismatch would mean the browser writes a
// session the Route Handlers can never read.
export const AUTH_COOKIE_NAME = "sb-stablepass-web-auth";
