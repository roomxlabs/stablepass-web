// Member app shell — the sidebar + content frame every member screen sits inside
// (chrome from 06-explore.html). Server component: resolves the session (RLS via
// httpOnly cookies) and redirects unauthenticated visitors to /signin. The browser
// never receives a token or the backend URL.
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { ACCESS_COLUMNS, hasAccess, type AccessRow } from "@/lib/api/access";
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
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/signin");

  const { data: profile } = await sb
    .from("app_user").select("name,email").eq("id", user.id).maybeSingle();
  // ACCESS_COLUMNS (not a hand-written column list) because the expiry banner
  // below runs the row through `hasAccess()` — the shared gate. Selecting fewer
  // columns than that helper reads is invisible to `tsc` (`sb` is untyped) and
  // fails CLOSED at runtime, so the constant is the structural fix: widening
  // the rule widens every select that feeds it. `trial_ends_at` also still
  // feeds the sidebar chip below.
  const { data: subscription } = await sb
    .from("subscription").select(ACCESS_COLUMNS).eq("user_id", user.id).maybeSingle();
  const sub = subscription as AccessRow | null;

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
