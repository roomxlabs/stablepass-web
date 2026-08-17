"use client";

// Expiry banner — "Your access ends in N days." with a way to buy more.
// Mounted by the (member) shell so it appears on EVERY member screen, not just
// Account (ENG-570 scope decision 2).
//
// ─────────────────────────────────────────────────────────────────────────────
// NO MOCKUP. `.rx/mockups.md` has no banner screen and none was drawn for one.
// Everything below is therefore composed from the EXISTING token set rather
// than an invented treatment — specifically the `.trial-banner-web` family
// already used on `/start` (app/globals.css:237): `--brand-green-soft` band,
// `--brand-green` left rule, an uppercase `.trial-label` eyebrow over a
// `.trial-detail` sentence. No new colour, no new font size, no new component.
//
// The only inline styles are LAYOUT, not treatment: the class was authored for
// a banner sitting inside an auth card (rounded right edge, 28px bottom
// margin), and here it is a full-bleed band across the top of `.main`. Zeroing
// that radius/margin and adding the flex row for the dismiss control is the
// whole delta — it adds nothing to the design system, which is why it is not a
// change to globals.css.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ENTITLEMENT RULE IS NOT RE-DERIVED HERE.
// `hasAccess()` (lib/api/access.ts, ENG-569) is the single place the rule
// "is this member entitled right now" is written in this repo, mirroring the
// backend's `has_content_access()`. This file calls it and does NOT reimplement
// any part of it — a second copy of the expiry rule is exactly how the sidebar
// chip and the banner end up disagreeing by a day, or worse, how the banner
// keeps nagging a member the gate has already walled off.
//
// What this file owns is only the DISPLAY question on top of that: given an
// entitled member, how many days are left and is that inside the warning
// window. That distinction matters — a wrong answer here shows the wrong
// number of days (cosmetic), whereas a wrong answer in `hasAccess()` locks a
// paying member out.
//
// GUARDRAIL — this is CHROME, NOT CONTENT (.rx/guardrails.md #3). It renders a
// sentence and a link and nothing else; it never fetches, renders or unlocks
// gated content, and it cannot suppress the 402 path — a member with no access
// gets `endsAt === null` from `expiryEndsAt` below and no banner at all.
import { useState, useSyncExternalStore } from "react";
import { hasAccess, type AccessRow } from "@/lib/api/access";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The banner arms inside the last week, inclusive of day 7. */
export const EXPIRY_WINDOW_DAYS = 7;

/**
 * The sessionStorage key. Session-scoped by design (scope decision 3): a
 * dismissal lasts the browsing session, not forever, and needs no DB column
 * and no new API.
 */
export const DISMISS_KEY = "expiry-dismissed";

/**
 * Whole days from `now` until `endsAt`, or null if there is no usable date.
 *
 * `Math.ceil` on the ms difference — the SAME convention `layout.tsx`'s trial
 * chip and `account/page.tsx` already use. A second rounding rule would make
 * the sidebar chip and this banner disagree by a day, which reads as a bug.
 */
export function daysUntil(endsAt: string | null, now: number = Date.now()): number | null {
  if (!endsAt) return null;
  const ts = Date.parse(endsAt);
  if (Number.isNaN(ts)) return null;
  return Math.ceil((ts - now) / DAY_MS);
}

/** The day count to show, or null when the banner should stay down. */
export function expiryDaysToShow(days: number | null): number | null {
  if (days === null) return null;
  // 0 and below: the period is over and the member is already gated (the
  // content routes 402). Telling them to renew is the gate's job at that
  // point, not a banner's — so there is deliberately no zero state.
  return days > 0 && days <= EXPIRY_WINDOW_DAYS ? days : null;
}

export function expiryMessage(days: number): string {
  return `Your access ends in ${days} ${days === 1 ? "day" : "days"}.`;
}

/**
 * The date this member is counting down to, or null when no banner is due.
 *
 * `endsAt` follows the STATUS, not "whichever date happens to be set": a trial
 * member counts down to `trial_ends_at`, everyone else to `current_period_end`.
 * An `active` member whose period end has not landed yet (the Stripe webhook is
 * in flight) therefore gets NO banner rather than a wrong one — `hasAccess`
 * deliberately treats that null as access-granting, and a null end is not an
 * imminent end.
 */
export function expiryEndsAt(sub: AccessRow | null, now: number = Date.now()): string | null {
  // The shared gate decides entitlement — lapsed/canceled/expired all fall out
  // here, and none of that logic is restated below.
  if (!hasAccess(sub, now)) return null;
  return sub!.status === "trial" ? sub!.trial_ends_at : sub!.current_period_end;
}

// ── Reading the dismissal without a setState-in-effect ──────────────────────
// `sessionStorage` is an external store that does not exist during the server
// render, which is exactly what `useSyncExternalStore` is for: React renders
// the SERVER snapshot (below) through hydration and only then swaps in the
// client one, so there is no flash of a banner this member already dismissed
// and no hydration mismatch. The obvious alternative — read it in a
// `useEffect` and `setState` — is a cascading render the lint rule rightly
// rejects (react-hooks/set-state-in-effect).
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Sentinel for "the client has not read storage yet" — keeps the band down. */
const NOT_HYDRATED = "__not_hydrated__";

function getServerSnapshot(): string {
  return NOT_HYDRATED;
}

function getSnapshot(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    // Storage can throw (private mode, blocked cookies). Showing the banner is
    // the safe failure here — it is a warning, not a wall.
    return null;
  }
}

export function ExpiryBanner({ subscription }: { subscription: AccessRow | null }) {
  const endsAt = expiryEndsAt(subscription);
  const days = expiryDaysToShow(daysUntil(endsAt));

  // Dismissal is remembered AS THE DATE it was dismissed for, never as a
  // boolean. That is what re-arms the banner after a renewal: buying more
  // access moves `endsAt`, which no longer matches the stored key, so the next
  // period's warning is not swallowed by a click from the previous one.
  const storedDismissal = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // The click's own record of the dismissal, so the band still goes away when
  // storage is unavailable and the write above silently failed. setState in an
  // event handler is exactly where it belongs.
  const [clickedDismissal, setClickedDismissal] = useState<string | null>(null);

  if (
    storedDismissal === NOT_HYDRATED ||
    days === null ||
    storedDismissal === endsAt ||
    clickedDismissal === endsAt
  ) {
    return null;
  }

  function dismiss() {
    setClickedDismissal(endsAt);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, endsAt!);
    } catch {
      // Non-fatal — `clickedDismissal` above already hid it for this session.
    }
    // Storage fires no event in the tab that wrote it, so nudge the store.
    listeners.forEach((l) => l());
  }

  return (
    <div
      className="trial-banner-web"
      role="status"
      data-testid="expiry-banner"
      // Layout only — see the header note. The class supplies every colour,
      // font and padding value; this makes it a full-bleed band instead of a
      // card-width one and lines the dismiss control up on the right.
      style={{
        borderRadius: 0,
        marginBottom: 0,
        display: "flex",
        alignItems: "center",
        gap: 16,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="trial-label">Access ending</div>
        <div className="trial-detail">
          {expiryMessage(days)}{" "}
          <a
            href="/checkout"
            style={{ color: "var(--brand-green)", fontWeight: 600, textDecoration: "underline" }}
          >
            Renew now
          </a>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        data-testid="expiry-banner-dismiss"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 4,
          lineHeight: 1,
          fontSize: 18,
          color: "var(--brand-green)",
        }}
      >
        &times;
      </button>
    </div>
  );
}
