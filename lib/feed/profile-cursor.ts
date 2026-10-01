// Paging for the two profile feeds — `/api/horses/:id/feed` and
// `/api/trainers/:id/feed` (ENG-1633). Both are direct, chronological reads,
// ordered `published_at desc, id desc`. The cursor is a keyset on that same
// pair — `<published_at>|<id>` of the last row — and page N+1 is
//   published_at < c  OR  (published_at = c AND id < cid)
// the tie-break the be feed keyset already uses. A bare `published_at < c`
// would permanently skip every post that shares the boundary timestamp (bulk
// or seeded publishes share `now()`), which is why the id is part of it.
//
// That matches the be contract, which has always named `?cursor=` →
// `{ data, meta }` for both routes; until ENG-1633 the web routes returned one
// fixed page of 20 and no meta, so neither profile could ever show an older
// post — let alone prefetch one.
//
// The cursor is echoed back from our own response, but it arrives in a query
// string, and its parts are interpolated into a PostgREST `.or()` filter. So
// BOTH halves are validated strictly (an ISO timestamp, a UUID) before they
// reach a filter — anything else is a 400, never a filter.

/** Rows per profile-feed page — the old fixed limit, unchanged for page 1. */
export const PROFILE_FEED_PAGE_SIZE = 20;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEP = "|";

export interface ProfileCursor {
  publishedAt: string;
  id: string;
}

/**
 * `?cursor=` off a request: `null` when absent, the parsed keyset when it is
 * `<ISO timestamp>|<uuid>`, `undefined` when present but malformed (the route
 * answers 400).
 */
export function parseProfileCursor(raw: string | null): ProfileCursor | null | undefined {
  if (raw === null || raw === "") return null;
  const parts = raw.split(SEP);
  if (parts.length !== 2) return undefined;
  const [publishedAt, id] = parts;
  if (!ISO_TIMESTAMP.test(publishedAt) || !Number.isFinite(Date.parse(publishedAt))) return undefined;
  if (!UUID.test(id)) return undefined;
  return { publishedAt, id };
}

/**
 * The PostgREST `.or()` filter for "rows after this cursor" in
 * `published_at desc, id desc` order. Only ever called with a cursor that
 * `parseProfileCursor` accepted, so neither value can carry a `,`, `(`, `)` or
 * `"`; the values are double-quoted anyway because a timestamp has `:` and `.`.
 */
export function profileCursorFilter(c: ProfileCursor): string {
  return `published_at.lt."${c.publishedAt}",and(published_at.eq."${c.publishedAt}",id.lt."${c.id}")`;
}

/** The `meta` for a page of rows: a full page means there may be more. */
export function profileFeedMeta(rows: { id?: string | null; published_at?: string | null }[]): { nextCursor: string | null; hasMore: boolean } {
  const last = rows[rows.length - 1];
  const hasMore =
    rows.length >= PROFILE_FEED_PAGE_SIZE && typeof last?.published_at === "string" && typeof last?.id === "string";
  return { nextCursor: hasMore ? `${last!.published_at}${SEP}${last!.id}` : null, hasMore };
}
