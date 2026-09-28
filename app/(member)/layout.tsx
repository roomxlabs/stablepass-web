// Member app shell — the sidebar + content frame every member screen sits inside
// (chrome from 06-explore.html). Server component: resolves the session (RLS via
// httpOnly cookies) and redirects unauthenticated visitors to /signin. The browser
// never receives a token or the backend URL.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { preconnect } from "react-dom";
import { supabaseServer } from "@/lib/supabase/server";
import { getViewer } from "@/lib/auth/viewer";
import { hasAccess, type AccessRow } from "@/lib/api/access";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { ExpiryBanner } from "./expiry-banner";
import { InstallPrompt } from "./install-prompt";
import { Sidebar, type SidebarUser } from "./sidebar";

// ENG-985 — iPad installs the app by adding it to the Home Screen, so the
// member space declares itself installable: the manifest that makes the
// installed result an app rather than a bookmark, plus the Apple-specific
// standalone declaration.
//
// BOTH are scoped HERE, to the member layout, and deliberately NOT to the root
// layout, because the root is shared with the (marketing) space and a public
// marketing brochure has no business claiming to be an installed app.
//
// That scoping is why the manifest is a static `public/manifest.webmanifest`
// referenced by `metadata.manifest` instead of the idiomatic `app/manifest.ts`
// file convention. The file convention was the first implementation and it was
// WRONG for this repo: Next injects `<link rel="manifest">` into every
// document, so every marketing page advertised itself as an installable
// standalone app whose `start_url: "/"` on the apex is the marketing page, not
// the app. Verified by curling `/`, `/legal/privacy` and the app routes.
// Referencing it explicitly here is what keeps the link on app documents only.
//
// `statusBarStyle: "default"` is deliberate and is the OPAQUE bar. The
// tinted-through alternative (`black-translucent`) draws the web view UNDER
// the status bar, which would need safe-area padding on every member screen to
// stop the topbar sliding beneath the clock — a shell-wide change this ticket
// has no mandate for. Opaque is the correct conservative default here.
export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "StablePass",
    statusBarStyle: "default",
  },
};

// ENG-585: the chip is only allowed to claim a trial is running while it
// actually is. It used to test `status === "trial"` alone and clamp the day
// count at zero, so a member whose trial had already expired got a sidebar
// reading "Trial · 0 days left" on every screen — the same raw-status lie as the
// Account pill, just smaller. `hasAccess()` (the shared rule) decides; the
// status string is then only allowed to pick the wording.
function trialLabel(sub: AccessRow | null): string | null {
  if (!hasAccess(sub) || sub?.status !== "trial" || !sub.trial_ends_at) return null;
  const ms = new Date(sub.trial_ends_at).getTime() - Date.now();
  const days = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  return `Trial · ${days} day${days === 1 ? "" : "s"} left`;
}

export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  // ENG-1593 — warm the connections the first card needs BEFORE any of it is
  // known. Every minted photo/poster and every browser-side read lives on the
  // Supabase origin; a cold TLS handshake there used to sit on the critical
  // path of the first image. Two hints because the pools differ: <img> loads
  // use the no-CORS pool, supabase-js `fetch` the anonymous-CORS one.
  // Member layout, not the root, so the marketing brochure pays for neither.
  const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (supabaseOrigin) {
    preconnect(supabaseOrigin);
    preconnect(supabaseOrigin, { crossOrigin: "anonymous" });
  }

  // ONE verified auth call per request (lib/auth/viewer.ts): the page below
  // reuses this answer instead of paying for its own `getUser()`.
  const user = await getViewer();
  if (!user) redirect("/signin");

  const sb = await supabaseServer();
  // ENG-1593 — the profile and the subscription are independent reads, so they
  // run together instead of back to back. The subscription goes through
  // `readSubscriptionState`, the per-request `cache()`d read, so the page under
  // this layout (which needs the same row) makes NO second query for it.
  //
  // That helper selects SUBSCRIPTION_COLUMNS, a superset of ACCESS_COLUMNS, so
  // `hasAccess()` below still sees every column it reads (the ENG-585 reason
  // this layout used the constant rather than a hand-written list).
  const [{ data: profile }, { sub: fullSub }] = await Promise.all([
    sb.from("app_user").select("name,email").eq("id", user.id).maybeSingle(),
    readSubscriptionState(user.id),
  ]);
  // Narrowed to the ACCESS columns before it goes anywhere near a client
  // component: the full row carries `stripe_customer_id`, which must never
  // reach browser JS (.rx/guardrails.md #1) — the ExpiryBanner is a client
  // island and would otherwise serialise it into the page.
  const sub: AccessRow | null = fullSub
    ? {
        status: fullSub.status,
        trial_ends_at: fullSub.trial_ends_at,
        current_period_end: fullSub.current_period_end,
      }
    : null;

  const name = profile?.name?.trim() || profile?.email?.split("@")[0] || "Member";
  const email = profile?.email || user.email || "";
  const sidebarUser: SidebarUser = {
    name,
    email,
    initial: (name[0] || "M").toUpperCase(),
    trialLabel: trialLabel(sub),
  };

  return (
    <div className="app-shell">
      <Sidebar user={sidebarUser} />
      <main className="main">
        {/*
          The banner is mounted here, in the shell, so the last-7-days warning
          reaches every member screen rather than only Account. It is a client
          island precisely so the rest of this layout stays a server component:
          `sessionStorage` (the dismissal) cannot be read during the server
          render, but nothing else here needs the browser.

          It renders null unless the member is entitled AND inside the window,
          so the common case costs an empty node — see ./expiry-banner.
        */}
        <ExpiryBanner subscription={sub} />
        {children}
        {/*
          ENG-985 — the iPad "Add to Home Screen" instruction. Mounted in the
          shell, like the banner above, so it reaches every member screen
          rather than only the feed. It is a client island for the same reason:
          the detection reads `navigator`/`matchMedia` and the dismissal reads
          `localStorage`, none of which exist during the server render.

          It renders null for everyone who is not an iPad Safari visitor, and
          for anyone already running it installed or who has dismissed it once
          — so the common case costs an empty node. See ./install-prompt.
        */}
        <InstallPrompt />
      </main>
    </div>
  );
}
