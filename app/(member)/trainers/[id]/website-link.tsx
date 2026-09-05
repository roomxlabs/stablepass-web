"use client";

// website-link — the "Visit trainer website" action (A2, ENG-274; wording ENG-959).
// On the TRAINER profile it renders as a secondary action alongside Follow/Notify
// (same `.btn .btn-light` treatment the Notify button uses), so it reads as part
// of the profile's action row. The HORSE profile reuses this same component as a
// green `primary` CTA when that horse has shares for sale (ENG-959) — one
// implementation, so the click log and the href validation cannot drift apart.
//
// Clicking opens the trainer's site in a new tab AND logs a first-party
// `trainer_website_click` row via the BFF. The log is deliberately
// FIRE-AND-FORGET: we never await it and never block/defer the navigation, so a
// slow or failing log can't cost the member the click. `keepalive` lets the POST
// survive the page losing focus to the new tab.
//
// GUARDRAIL: first-party log only — no tracking pixel, no 3rd-party beacon. The
// row's user_id is derived server-side from the session; this component never
// sends (or knows) a user id.

import { safeHref } from "@/lib/trainer/website";

const ExternalLinkIcon = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 4h6v6" />
    <path d="M20 4 12 12" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

/**
 * ONE wording for the website call-to-action, everywhere it appears (ENG-959,
 * porting mobile's `TRAINER_WEBSITE_LABEL` in lib/profiles.ts).
 *
 * Was a bare "Website" here. Justin, 1 Sep 2026, settled a single label for BOTH
 * the trainer page and the horse page, and retired the shares-specific wording
 * outright ("just trying to avoid the words see-available-shares etc"). The
 * SHARES AVAILABLE tag on the horse page is now the only shares signal, and that
 * is the client's deliberate choice. The destination never changed — it was
 * always the trainer's public `website_url`.
 */
export const TRAINER_WEBSITE_LABEL = "Visit trainer website";

export interface WebsiteLinkProps {
  trainerId: string;
  websiteUrl: string | null;
  /**
   * `light` (the default) is the trainer profile's secondary action, sitting in
   * a row beside Follow/Notify. The horse profile passes `primary`, where mobile
   * draws this as the green primary CTA under the header — it is the only action
   * on that screen, not one of three.
   */
  variant?: "light" | "primary";
}

// The http(s)-only URL rules live in lib/trainer/website.ts, NOT here: this is a
// `"use client"` module, and the horse profile (a SERVER component) must call
// `hasLinkableWebsite` before it draws the CTA's wrapper. Calling an export of a
// client module from the server is a runtime RSC boundary error that neither
// `tsc` nor a jsdom test catches, so the pure helpers moved to `lib/` where both
// sides can import them (ENG-959).

export function WebsiteLink({ trainerId, websiteUrl, variant = "light" }: WebsiteLinkProps) {
  // No URL set on the trainer → the action simply doesn't exist.
  if (!websiteUrl || websiteUrl.trim() === "") return null;

  const href = safeHref(websiteUrl);
  if (!href) return null;

  function logClick() {
    // Not awaited — navigation must proceed regardless of the log's fate.
    void fetch(`/api/trainers/${trainerId}/website-click`, {
      method: "POST",
      keepalive: true,
    }).catch(() => {
      /* logging is best-effort; never surface or block on a failure */
    });
  }

  return (
    <a
      className={`btn btn-${variant}`}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={logClick}
      // onAuxClick covers middle-click "open in new tab", which never fires
      // onClick — without it the metric silently undercounts. React fires
      // onClick for the primary button only, so the two can't double-log.
      //
      // Guarded to button 1 (middle) specifically: auxclick fires for ANY
      // non-primary button, so an unguarded handler also logs a right-click —
      // "Copy link address" would count as a visit that never happened.
      // Undercounting middle-clicks is a smaller sin than inventing clicks.
      onAuxClick={(e) => {
        if (e.button === 1) logClick();
      }}
    >
      <ExternalLinkIcon /> {TRAINER_WEBSITE_LABEL}
    </a>
  );
}
