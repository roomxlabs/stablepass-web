// Member app shell — the sidebar + content frame every member screen sits inside
// (chrome from 06-explore.html). Server component: resolves the session (RLS via
// httpOnly cookies) and redirects unauthenticated visitors to /signin. The browser
// never receives a token or the backend URL.
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { Sidebar, type SidebarUser } from "./sidebar";

function trialLabel(status?: string | null, trialEndsAt?: string | null): string | null {
  if (status !== "trial" || !trialEndsAt) return null;
  const ms = new Date(trialEndsAt).getTime() - Date.now();
  const days = Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  return `Trial · ${days} day${days === 1 ? "" : "s"} left`;
}

export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/signin");

  const { data: profile } = await sb
    .from("app_user").select("name,email").eq("id", user.id).maybeSingle();
  const { data: subscription } = await sb
    .from("subscription").select("status,trial_ends_at").eq("user_id", user.id).maybeSingle();

  const name = profile?.name?.trim() || profile?.email?.split("@")[0] || "Member";
  const email = profile?.email || user.email || "";
  const sidebarUser: SidebarUser = {
    name,
    email,
    initial: (name[0] || "M").toUpperCase(),
    trialLabel: trialLabel(subscription?.status, subscription?.trial_ends_at),
  };

  return (
    <div className="app-shell">
      <Sidebar user={sidebarUser} />
      <main className="main">{children}</main>
    </div>
  );
}
