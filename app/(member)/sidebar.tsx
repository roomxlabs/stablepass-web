"use client";

// Member sidebar (shell chrome from 06-explore.html). Client component so the active
// nav item tracks the route. Sign out only — no devices/sessions UI (single-device).
import { usePathname, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

type IconName = "home" | "user" | "horse" | "heart" | "bookmark" | "bell" | "settings";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" /></>,
    horse: <path d="M4 21c0-6 3-9 6-10l1-3 3 1 2-2 1 4c2 2 3 5 3 10" />,
    heart: <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" />,
    bookmark: <path d="M6 3h12v18l-6-4-6 4Z" />,
    bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3m10-10h-3M5 12H2m15.5-6.5-2 2m-9 9-2 2m13 0-2-2m-9-9-2-2" /></>,
  };
  return <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

const PRIMARY_NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/explore", label: "Explore", icon: "home" },
  { href: "/trainers", label: "Trainers", icon: "user" },
  { href: "/horses", label: "Horses", icon: "horse" },
  { href: "/following", label: "Following", icon: "heart" },
];
const STABLE_NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/saved", label: "Saved", icon: "bookmark" },
  { href: "/notifications", label: "Notifications", icon: "bell" },
  { href: "/account", label: "Account", icon: "settings" },
];

export type SidebarUser = { name: string; email: string; initial: string; trialLabel: string | null };

export function Sidebar({ user }: { user: SidebarUser }) {
  const pathname = usePathname();
  const router = useRouter();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    router.push("/signin");
    router.refresh();
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">stablepass.</div>

      <ul className="sidebar-nav">
        {PRIMARY_NAV.map((item) => (
          <li key={item.href}>
            <a className={isActive(item.href) ? "active" : undefined} href={item.href}>
              <Icon name={item.icon} /> {item.label}
            </a>
          </li>
        ))}
      </ul>

      <div className="sidebar-section">Your stable</div>
      <ul className="sidebar-nav">
        {STABLE_NAV.map((item) => (
          <li key={item.href}>
            <a className={isActive(item.href) ? "active" : undefined} href={item.href}>
              <Icon name={item.icon} /> {item.label}
            </a>
          </li>
        ))}
      </ul>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="avatar">{user.initial}</div>
          <div className="meta">
            <strong>{user.name}</strong>
            <span className="email">{user.email}</span>
          </div>
        </div>
        {user.trialLabel && <div className="trial-badge-sidebar">{user.trialLabel}</div>}
        <button
          type="button"
          onClick={signOut}
          className="btn btn-light btn-block"
          style={{ marginTop: 12, fontSize: 13, padding: "9px 14px" }}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
