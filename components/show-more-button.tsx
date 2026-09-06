"use client";

// ShowMoreButton — the pager control for the "Show more" browse surfaces.
//
// WHY THIS EXISTS (ENG-1038). ENG-960 shared the paging *arithmetic*
// (`lib/browse.ts`) but not the *control*: the button is copy-pasted between
// `app/(member)/horses/horses-grid.tsx` and `app/(member)/trainers/trainers-grid.tsx`,
// inline styles and all. /shares is the third surface that needs it, and a
// third copy is the point at which the duplication stops being cheap — the two
// existing copies already have to agree on four coupled things (the disabled
// rule, the three-way label, that the retry line sits ABOVE the button, and
// that `pageError` does not retire the button), and nothing makes them.
//
// SCOPE NOTE: this component is currently used by /shares ONLY. The two browse
// grids are in PR #104's declared file surface (ENG-960, awaiting re-review),
// so converting them here would collide with an in-flight PR. Converting them
// is filed as its own follow-up — see the ENG-1038 PR body.
//
// The three-way label is the load-bearing part. A pager that renders but
// fetches nothing, or that says "Show more" after the fetch it just tried
// failed, is the failure mode ENG-960's self-review caught:
//   - loadingMore -> "Loading…", and the button is disabled so a double-click
//     cannot fire two fetches at the same offset (which would duplicate rows);
//   - pageError   -> "Try again", because the roster is deliberately KEPT on a
//     failed page (see the `pageError` split in the caller) and the retry has
//     to be one click, not a page reload;
//   - otherwise   -> "Show more".

export function ShowMoreButton({
  loadingMore,
  pageError,
  onClick,
  className,
}: {
  loadingMore: boolean;
  pageError: boolean;
  onClick: () => void;
  /** The caller owns the styling — the grids use a global `.btn-showmore`, /shares a CSS module. */
  className?: string;
}) {
  return (
    <button type="button" className={className} disabled={loadingMore} onClick={onClick}>
      {loadingMore ? "Loading…" : pageError ? "Try again" : "Show more"}
    </button>
  );
}
