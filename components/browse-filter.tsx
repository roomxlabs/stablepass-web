"use client";

// BrowseFilter — the All / Following pill pair on the browse screens (ENG-960).
//
// Web port of mobile's `src/components/browse-filter.tsx`. Mobile's ENG-870
// dropped the Racehorses / Retired / Shares pills back to this same pair:
// for-sale horses are already inside "All" (the R8 reversal this ticket also
// applies to the queries below), so a Shares pill was a filtered duplicate of
// the Shares TAB, and Racehorses listed All-minus-retired, a distinction the
// client did not ask to keep.
//
// NOT the same control as the `Following` segment on Explore, which is a POST
// feed from everything you follow. This filters the ROSTER you are browsing.
// Both exist on purpose — mobile's copy of this note says the same.
//
// NO MOCKUP COVERS THIS (mobile's original carries the same caveat; the web
// mockups draw the unfiltered grids only). The visual language is borrowed from
// the existing `.tag` pills in `app/globals.css` — cream fill, hairline
// `--line` border, brand-green when active — so it reads as StablePass rather
// than a new control.
//
// DELIBERATE DEVIATION FROM MOBILE: mobile positions the pills `absolute` over
// the list so toggling them cannot push the roster down on a phone, and pays
// for it with exported clearance constants the host list must inset by. Web has
// the width and a real page heading to sit under, so the row is in normal flow
// beneath the `<h1>` — no overlap, no clearance arithmetic, nothing for a host
// grid to get wrong.
export const BROWSE_FILTERS = ["all", "following"] as const;

export type BrowseFilterValue = (typeof BROWSE_FILTERS)[number];

const LABELS: Record<BrowseFilterValue, string> = {
  all: "All",
  following: "Following",
};

export function BrowseFilter({
  value,
  onChange,
  options = BROWSE_FILTERS,
  testId = "browse-filter",
}: {
  value: BrowseFilterValue;
  onChange: (next: BrowseFilterValue) => void;
  options?: readonly BrowseFilterValue[];
  testId?: string;
}) {
  return (
    <div className="browse-filter" data-testid={testId}>
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            data-testid={`${testId}-${option}`}
            // NOT `role="tab"`: `test/member-layout.test.ts` asserts the member
            // shell exposes exactly the primary nav tabs, and a second tablist
            // would break that. `aria-pressed` is the correct role for a
            // two-state filter toggle anyway.
            aria-pressed={active}
            aria-label={`Show ${LABELS[option].toLowerCase()}`}
            className={`browse-pill${active ? " is-active" : ""}`}
            onClick={() => onChange(option)}
          >
            {LABELS[option]}
          </button>
        );
      })}
    </div>
  );
}
