// Member app shell — the sidebar + content frame every member screen sits inside
// (chrome from 06-explore.html). Server component: resolves the session (RLS via
// httpOnly cookies) and redirects unauthenticated visitors to /signin. The browser
// never receives a token or the backend URL.
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { ACCESS_COLUMNS, hasAccess, type AccessRow } from "@/lib/api/access";
import { ExpiryBanner } from "./expiry-banner";
import { Sidebar, type SidebarUser } from "./sidebar";

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
      </main>
    </div>
  );
}
