"use client";

// Member sidebar (shell chrome from 06-explore.html). Client component so the active
// nav item tracks the route. Sign out only — no devices/sessions UI (single-device).
//
// Three shell stages, all driven from globals.css (see "shell responsive"):
//   >=1280   full 240px sidebar
//   900-1280 72px icon-only rail — labels go sr-only, the wordmark swaps for the S. mark
//   <900     off-canvas drawer behind the hamburger rendered here
// The drawer state lives in this component (rather than the layout) so the whole
// shell interaction stays in one file and the layout can remain a server component.
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Wordmark, BrandMark } from "@/components/wordmark";
import { formatUnreadBadge, UNREAD_CHANGED_EVENT } from "@/app/api/notifications/contract";

type IconName = "home" | "user" | "horseshoe" | "heart" | "tag" | "bookmark" | "bell" | "account";

function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, React.ReactNode> = {
    home: <><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" /></>,
    // Horseshoe, tips up: the U band plus a flared heel calkin across each tip.
    // Nail holes were tried and dropped — at 18px an r=1 dot lands on the 1.8px
    // stroke rather than inside the band, so it reads as clutter (a "U" with an
    // umlaut) instead of detail. The flared tips are what separate this from a
    // letterform.
    horseshoe: (
      <>
        <path d="M7.2 4.6C5.3 8.5 4.8 12.7 6.2 15.7c1.2 2.6 3.3 3.9 5.8 3.9s4.6-1.3 5.8-3.9c1.4-3 .9-7.2-1-11.1" />
        <path d="M5.5 4.5h3.4M14.7 4.5h3.4" />
      </>
    ),
    heart: <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" />,
    // Shares — a tag (acquisition surface). No price glyph: guardrail 8 forbids
    // betting/prices in the UI; the tab is for for-sale horses, not markets.
    tag: (
      <>
        <path d="M20.6 13.4 12.4 21.6a2 2 0 0 1-2.8 0L2.4 14.4a2 2 0 0 1 0-2.8L10.6 3.4a2 2 0 0 1 1.4-.6H19a1 1 0 0 1 1 1v6.9a2 2 0 0 1-.4 1.3Z" />
        <circle cx="16" cy="8" r="1.2" fill="currentColor" stroke="none" />
      </>
    ),
    bookmark: <path d="M6 3h12v18l-6-4-6 4Z" />,
    bell: <><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
    // Account = person in a ring. The ring is what distinguishes it from Trainers,
    // which owns the bare person glyph, and it echoes the footer avatar.
    account: (
      <>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="10" r="3" />
        <path d="M6.6 18.5a6 6 0 0 1 10.8 0" />
      </>
    ),
  };
  return <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

const PRIMARY_NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/explore", label: "Explore", icon: "home" },
  { href: "/trainers", label: "Trainers", icon: "user" },
  { href: "/horses", label: "Horses", icon: "horseshoe" },
  { href: "/following", label: "Following", icon: "heart" },
  // ENG-831 — needs-design-check: Explore mockup has no Shares; icon + placement
  // match existing primary items (after Following, before Your stable).
  { href: "/shares", label: "Shares", icon: "tag" },
];
const STABLE_NAV: { href: string; label: string; icon: IconName }[] = [
  { href: "/saved", label: "Saved", icon: "bookmark" },
  { href: "/notifications", label: "Notifications", icon: "bell" },
  { href: "/account", label: "Account", icon: "account" },
];

export type SidebarUser = { name: string; email: string; initial: string; trialLabel: string | null };

/**
 * The unread-notifications chip (ENG-957).
 *
 * Fetched from the BFF rather than passed down from the layout, for two reasons:
 * the layout is a server component that renders ONCE per navigation to a new
 * document, and the count has to change after the member reads something in the
 * inbox — a prop would go stale the moment they clear a row. The BFF does a
 * `head: true` count, so this costs a number, never the rows.
 *
 * Refreshed on navigation, per the ticket: `pathname` is the dependency, so
 * moving between member screens re-reads it, and coming BACK from /notifications
 * (where rows were just marked read) is exactly the case that must not show a
 * stale chip.
 *
 * A failure renders NO chip rather than a zero: "0 unread" and "we couldn't ask"
 * are different states, and quietly claiming the first is how a member stops
 * trusting the badge.
 */
function useUnreadCount(pathname: string): number {
  const [unread, setUnread] = useState(0);
  // Bumped by the inbox's UNREAD_CHANGED_EVENT — "Mark all read" changes the
  // count WITHOUT navigating, and without this the chip would go on claiming N
  // unread beside a screen the member has just cleared.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const bump = () => setRevision((n) => n + 1);
    window.addEventListener(UNREAD_CHANGED_EVENT, bump);
    return () => window.removeEventListener(UNREAD_CHANGED_EVENT, bump);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/notifications/unread-count", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { data?: { unread?: number } };
        if (!cancelled) setUnread(body.data?.unread ?? 0);
      } catch {
        if (!cancelled) setUnread(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname, revision]);

  return unread;
}

export function Sidebar({ user }: { user: SidebarUser }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const unreadCount = useUnreadCount(pathname);
  const unreadBadge = formatUnreadBadge(unreadCount);

  // Navigating closes the drawer — otherwise it stays over the page you just opened.
  // Adjusted during render rather than in an effect: React's documented pattern for
  // resetting state when a prop changes, and it avoids the cascading re-render an
  // effect-plus-setState would cause.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    router.push("/signin");
    router.refresh();
  }

  function navList(items: typeof PRIMARY_NAV) {
    return (
      <ul className="sidebar-nav">
        {items.map((item) => {
          const badge = item.href === "/notifications" ? unreadBadge : null;
          return (
            <li key={item.href}>
              <a
                className={isActive(item.href) ? "active" : undefined}
                href={item.href}
                title={item.label}
                aria-current={isActive(item.href) ? "page" : undefined}
              >
                <Icon name={item.icon} />
                {/* The count is carried on the LABEL, not only in the chip: the
                    900-1279 rail hides .nav-label (globals.css) and would
                    otherwise leave a bare number with nothing naming it. */}
                <span className="nav-label">
                  {item.label}
                  {badge && <span className="sr-only"> — {badge} unread</span>}
                </span>
                {badge && (
                  <span className="nav-badge" data-testid="sidebar-unread-badge" aria-hidden="true">
                    {badge}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      <button
        type="button"
        className={open ? "nav-toggle is-open" : "nav-toggle"}
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
        aria-controls="member-sidebar"
        onClick={() => setOpen((v) => !v)}
      >
        <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
          {open
            ? <path d="M6 6l12 12M18 6L6 18" />
            : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
      </button>

      {open && (
        <div className="sidebar-backdrop" data-testid="sidebar-backdrop" onClick={() => setOpen(false)} />
      )}

      <aside id="member-sidebar" className={open ? "sidebar open" : "sidebar"}>
        <div className="sidebar-logo">
          <Wordmark className="sidebar-wordmark" />
          <BrandMark className="sidebar-brandmark" />
        </div>

        {navList(PRIMARY_NAV)}

        <div className="sidebar-section">Your stable</div>
        {navList(STABLE_NAV)}

        <div className="sidebar-footer">
          <div className="sidebar-user">
            {/* The 900-1279 rail hides .meta entirely (globals.css), so the avatar
                is the ONLY account affordance at that width — carry the address on
                it too, or a rail member cannot tell which account they are in. */}
            <div className="avatar" title={user.email}>
              {user.initial}
            </div>
            <div className="meta">
              <strong>{user.name}</strong>
              {/* title keeps the FULL address reachable once the CSS ellipsis
                  truncates it — the member has to be able to confirm which
                  account they are signed in as. */}
              <span className="email" title={user.email}>
                {user.email}
              </span>
            </div>
          </div>
          {user.trialLabel && <div className="trial-badge-sidebar">{user.trialLabel}</div>}
          <button type="button" onClick={signOut} className="btn btn-light btn-block sidebar-signout">
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
