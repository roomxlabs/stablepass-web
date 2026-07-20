"use client";

// website-link — the trainer-profile "Website" action (A2, ENG-274). Renders as a
// secondary action alongside Follow/Notify (same `.btn .btn-light` treatment the
// Notify button uses), so it reads as part of the profile's action row.
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

const ExternalLinkIcon = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 4h6v6" />
    <path d="M20 4 12 12" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

export interface WebsiteLinkProps {
  trainerId: string;
  websiteUrl: string | null;
}

// Only absolute http(s) URLs are linkable. `trainer.website_url` is an unconstrained
// `text` column, so a bare domain ("wallerracing.com.au") would otherwise render as a
// RELATIVE href and silently resolve to /trainers/<id>/wallerracing.com.au — a broken
// in-app link. Anything that isn't a parseable http(s) URL renders no action at all
// (React already neutralises `javascript:` hrefs; this doesn't rely on that).
// URL is used to VALIDATE only — we return the trainer's original string rather than
// url.href, because normalisation would rewrite what the admin entered (notably
// appending a trailing slash to a bare origin).
function safeHref(raw: string): string | null {
  const trimmed = raw.trim();
  try {
    const { protocol } = new URL(trimmed);
    return protocol === "http:" || protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}

export function WebsiteLink({ trainerId, websiteUrl }: WebsiteLinkProps) {
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
      className="btn btn-light"
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
      <ExternalLinkIcon /> Website
    </a>
  );
}
