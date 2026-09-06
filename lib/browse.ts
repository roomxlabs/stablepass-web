// Browse paging — the shared page size for the Horses / Trainers browse grids.
//
// ENG-960 (parity audit rows 12/13/38). Mirrors mobile's `BROWSE_PAGE_SIZE`
// (stablepass-mobile `lib/browse.ts:24`), which bounds every `listHorses` /
// `listTrainers` read. ENG-956 already set this precedent on the web side:
// `app/(member)/shares/shares-list.tsx` declares `SHARES_PAGE_SIZE = 100` with
// the same "mirrors mobile" note. The browse grids were the only holdout —
// before this they read UNBOUNDED.
//
// THE NUMBER IS A DECISION, NOT AN ACCIDENT. web PR #81 (`perf/query-batch`)
// pages at 60; mobile and web's own Shares list page at 100. Both are defensible
// on perf, and with the "Show more" pager below no row is unreachable at either
// value, so the tiebreak is repo consistency: 100 is what the other two bounded
// web/mobile browse reads already use, and a member scanning A-Z gets fewer
// clicks to cross the alphabet.
//
// PAGING, NOT TRUNCATION. An earlier revision of this file shipped the cap as a
// bare `.limit()` with no pager, which made row 101 unreachable from browse.
// Both grids now read `.range(offset, offset + BROWSE_PAGE_SIZE)` behind a
// "Show more" button — the mechanism ENG-960 asked to keep, lifted from #81's
// `2951602` (only the paging shape; #81's unrelated perf work stays with #81).
export const BROWSE_PAGE_SIZE = 100;

// Off-by-one guard, and the one place it is explained.
//
// #81 settles "is there another page?" with `rows.length === PAGE_SIZE`. That is
// wrong when the total is an EXACT multiple of the page size: the last full page
// offers "Show more", and pressing it fetches an empty page. Requesting ONE more
// row than we render answers the question exactly — if the extra row came back
// there is genuinely more, and we drop it from the render. `.range()` bounds are
// inclusive, so `offset + BROWSE_PAGE_SIZE` is PAGE_SIZE + 1 rows.
export const BROWSE_FETCH_LIMIT = BROWSE_PAGE_SIZE + 1;

/**
 * Split a raw `.range(offset, offset + BROWSE_PAGE_SIZE)` result into the page
 * we render and the answer to "is there more?". Shared so the two grids cannot
 * drift apart on the off-by-one.
 */
export function splitBrowsePage<T>(rows: T[]): { page: T[]; hasMore: boolean } {
  return { page: rows.slice(0, BROWSE_PAGE_SIZE), hasMore: rows.length > BROWSE_PAGE_SIZE };
}
