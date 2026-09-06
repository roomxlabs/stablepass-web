// Browse paging — the shared cap for the Horses / Trainers browse grids.
//
// ENG-960 (parity audit rows 12/13/38). Mirrors mobile's `BROWSE_PAGE_SIZE`
// (stablepass-mobile `lib/browse.ts:24`), which bounds every `listHorses` /
// `listTrainers` read at 100 rows. ENG-956 already set this precedent on the
// web side: `app/(member)/shares/shares-list.tsx` declares
// `SHARES_PAGE_SIZE = 100` with the same "mirrors mobile" note. The browse
// grids were the only holdout — before this they read UNBOUNDED.
//
// SCOPE NOTE — the "Show more" half of the ticket is deliberately not here.
// The ticket asks to "keep that mechanism, align the number or note why not",
// where "that mechanism" is the 60-item `Show more` pager from web PR #81
// (`perf/query-batch`). That PR is still open, targets `main` (not this
// ticket's `feature/launch-v1` base) and is CONFLICTING, so the mechanism does
// not exist anywhere on this branch — there is no pager to keep and no 60 to
// align. This ships the *cap* half (the number the ticket actually names) and
// leaves the pager to follow #81, per the ticket's own escape clause.
//
// Consequence worth knowing while #81 is unlanded: with no pager, a roster
// larger than the cap is truncated with no way to reach row 101. That is the
// same bound mobile has shipped since ENG-424, and strictly better than the
// unbounded read it replaces, but it is why #81 finishes the job.
export const BROWSE_PAGE_SIZE = 100;
