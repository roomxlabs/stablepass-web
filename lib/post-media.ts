import type { SupabaseClient } from "@supabase/supabase-js";
import { POST_MEDIA_BUCKET, signPhotoMap } from "./storage/photos";
import type { PostPhoto } from "@/components/types";

/**
 * post-media — the multi-photo read (round 6 / ENG-762), the web twin of
 * mobile's `lib/post-media.ts` (ENG-757). One file, so the five member surfaces
 * that each carry their own row type and mapper share ONE definition of how
 * `post_media` is read and signed instead of five that drift.
 *
 * WHY A SEPARATE TABLE READ AND NOT A WIDER `post` PROJECTION. Two reasons, and
 * the second is the load-bearing one:
 *
 * 1. It is the contract's own instruction (ENG-740's api-contract): "One batched
 *    read per feed page, direct PostgREST under RLS ... Do not query per post."
 *
 * 2. `post_media` is NOT deployed on `stablepass-be` main — it exists only on
 *    `feature/round6-v1`. An explicit PostgREST projection naming a column that
 *    is not deployed fails `42703`/HTTP 400, and because our reads destructure
 *    only `data`, that surfaces as a cheerful empty result — a SILENT total
 *    content blackout, not an error (.rx/gotchas.md). Widening the `post`
 *    projection would therefore blank the entire feed anywhere the migration has
 *    not landed. Isolated in its own query, the same failure costs only the
 *    carousel: `readPostPhotos` returns an empty map, every card falls back to
 *    `post.media_url`, and the feed renders exactly as it does today.
 *
 * WHERE THIS RUNS — stated plainly, because the ticket's prose says otherwise.
 * ENG-762 describes the BFF signing "server-side per house pattern". It does not:
 * all five call sites are `"use client"` islands passing `supabaseBrowser()`, so
 * both the select AND the signing happen in the browser, and the bare object path
 * (`<postId>/original`) is visible to browser JS in between. That is the EXISTING
 * house pattern — `lib/storage/photos.ts` is already called exactly this way for
 * `post.media_url` and `poster_url` on every one of those screens — so this
 * follows it rather than inventing a second mechanism beside it.
 *
 * The boundary is RLS, not secrecy of the path, and it was checked against the
 * running stack rather than assumed:
 *   - bucket `post-media` is PRIVATE, so an unsigned path fetches nothing;
 *   - `post_media_select_sub` requires the parent post be `status = 'published'`
 *     AND `has_content_access(auth.uid())`;
 *   - `storage.objects` policy `media gated read` requires
 *     `has_content_access(auth.uid()) OR is_admin(auth.uid())` to mint a URL.
 * A lapsed or signed-out viewer can therefore neither read the rows nor sign a
 * path. What must never happen is a raw path reaching an `<img src>` in place of
 * a signed URL — that is what the unit tests and the e2e actually assert.
 */

/**
 * The exact projection. Pinned as an exported constant because a test asserting
 * it with `.toBe(...)` is the only thing that catches BOTH failure directions —
 * too narrow silently starves the carousel, too wide silently blanks the read —
 * and `sb` is untyped, so `tsc` catches neither.
 */
export const POST_MEDIA_COLUMNS = "post_id, sort_order, media_url";

type PostMediaRow = {
  post_id: string;
  sort_order: number;
  media_url: string | null;
};

/**
 * Batched: ONE select and ONE signing round trip for a whole page of posts.
 *
 * Returns a map keyed by post id. A post with no rows is simply absent — which
 * is every legacy post, since ENG-740 ships no backfill. The contract is
 * explicit that "0 rows" and "1 photo" are the SAME rendering case (no dots, no
 * pager), because `post.media_url` mirrors the `sort_order = 0` row; deciding
 * that is the card's job, so this returns whatever the table holds.
 */
export async function readPostPhotos(
  sb: SupabaseClient,
  postIds: ReadonlyArray<string>,
): Promise<Map<string, PostPhoto[]>> {
  const out = new Map<string, PostPhoto[]>();
  const ids = Array.from(new Set(postIds.filter(Boolean)));
  if (ids.length === 0) return out;

  // `error` is deliberately inspected rather than dropped: an undeployed table
  // reads back as `{ data: null, error }`, and treating that as "no photos" is
  // the correct degrade — but silently, so the feed still renders.
  const { data, error } = await sb
    .from("post_media")
    .select(POST_MEDIA_COLUMNS)
    .in("post_id", ids)
    .order("post_id", { ascending: true })
    .order("sort_order", { ascending: true });

  if (error || !data) return out;

  const rows = data as unknown as PostMediaRow[];

  // One signing round trip for every path on the page. `signPhotoMap` dedupes
  // and degrades per key, so a single unsignable object costs its own slide and
  // nothing else.
  const signed = await signPhotoMap(sb, POST_MEDIA_BUCKET, rows.map((r) => r.media_url));

  for (const row of rows) {
    if (!row?.post_id) continue;
    const list = out.get(row.post_id) ?? [];
    list.push({
      // `null` when this one object failed to sign. The slide draws the media
      // ground and its siblings still render.
      url: row.media_url ? signed.get(row.media_url) ?? null : null,
      sort: row.sort_order,
    });
    out.set(row.post_id, list);
  }

  // Re-sort in memory rather than trusting the wire order. PostgREST honours the
  // `order` above today, but the ORDER is the product behaviour here — the admin
  // chose it — and `sort_order` is documented as possibly NON-CONTIGUOUS
  // (`{0,3,7}` is legal), so nothing may infer position from array index.
  for (const list of out.values()) list.sort((a, b) => a.sort - b.sort);

  return out;
}
