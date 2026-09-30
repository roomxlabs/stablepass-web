// Paging for the two profile feeds — `/api/horses/:id/feed` and
// `/api/trainers/:id/feed` (ENG-1633). Both are direct, chronological reads
// (`published_at desc`), so the cursor is the last row's `published_at`, and
// page N+1 is `published_at < cursor`. That matches the be contract, which has
// always named `?cursor=` → `{ data, meta }` for both routes; until ENG-1633 the
// web routes returned one fixed page of 20 and no meta, so neither profile could
// ever show an older post — let alone prefetch one.
//
// The cursor is echoed back from our own response, but it arrives in a query
// string, so it is validated as a timestamp before it reaches a filter.

/** Rows per profile-feed page — the old fixed limit, unchanged for page 1. */
export const PROFILE_FEED_PAGE_SIZE = 20;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * `?cursor=` off a request: `null` when absent, the value when it is an ISO
 * timestamp, `undefined` when present but malformed (the route answers 400).
 */
export function parseProfileCursor(raw: string | null): string | null | undefined {
  if (raw === null || raw === "") return null;
  return ISO_TIMESTAMP.test(raw) && Number.isFinite(Date.parse(raw)) ? raw : undefined;
}

/** The `meta` for a page of rows: a full page means there may be more. */
export function profileFeedMeta(rows: { published_at?: string | null }[]): { nextCursor: string | null; hasMore: boolean } {
  const last = rows[rows.length - 1];
  const hasMore = rows.length >= PROFILE_FEED_PAGE_SIZE && typeof last?.published_at === "string";
  return { nextCursor: hasMore ? (last!.published_at as string) : null, hasMore };
}
