// Client-island fetcher for POST /api/posts/media — the ONLY way a member
// island obtains a photo/voice display URL from the private post-media bucket
// after ENG-799. Browser never talks to the edge function or signs a path.
//
// Contract (BFF → be post-media). TWO MODES, chosen by the body's shape, and
// BOTH are post-id addressed — the client names a post and an ordinal, the
// SERVER resolves the storage path (ENG-809 decision 2). Nothing in this file
// ever builds or sends a path, and that is the property that stops a member
// minting another post's — or a draft's — objects:
//
//   POST { postIds: string[] }            1..50, never a path
//   200 { data: { items: [{ postId, mediaUrl, slideCount }], expiresAt } }
//   402 → PostMediaError('gated')         reactivate wall (must not silent-empty)
//   other non-ok / network → empty Map    placeholder, never a crash
//
//   POST { postId, slideIndex }           one slide, 0..9, never a path
//   200 { data: { postId, slideIndex, mediaUrl: string | null, expiresAt } }
//   anything else, 402 INCLUDED → null    placeholder, never gated bytes
//
// A post id ABSENT from items (draft/unpublished) is absent from the Map —
// ordinary placeholder, no error copy. A slide the caller is not entitled to
// comes back as `mediaUrl: null` at EVERY index, deliberately indistinguishable
// from an index past the end, so a status code can never confirm that a draft
// exists.
import { postPosterKey } from "@/lib/storage/photos";

const BATCH = 50;

/**
 * The be's own bound on an addressable slide ordinal (`MAX_SLIDE_INDEX` in
 * `supabase/functions/post-media/index.ts`, mirroring the table's
 * `sort_order between 0 and 9` CHECK). Asking outside it is a 400 there, so it
 * is refused here without a request.
 */
const MAX_SLIDE_INDEX = 9;

/** One post's slide 0 plus how many slides it has, as the batch returns them. */
export interface PostMediaItem {
  mediaUrl: string;
  /**
   * `slideCount` off the wire. HIGHEST ORDINAL + 1 rather than a row count —
   * the be documents why — so it is an upper bound on addressable slides, and
   * it is what draws the dots BEFORE any further slide is minted.
   */
  slideCount: number;
}

/** What one page of posts needs to draw its media: urls, and slide counts. */
export interface PostDisplayMedia {
  /** `post id -> minted url` (or an absolute passthrough, keyed by its value). */
  urls: Map<string, string>;
  /** `post id -> slideCount`. Absent means the legacy single-photo case. */
  slideCounts: Map<string, number>;
}

export type PostMediaFailure = "gated" | "failed";

export class PostMediaError extends Error {
  readonly reason: PostMediaFailure;

  constructor(reason: PostMediaFailure, message: string = reason) {
    super(message);
    this.name = "PostMediaError";
    this.reason = reason;
  }
}

const isAbsoluteUrl = (v: string): boolean => /^(https?:|blob:|data:)/i.test(v);

/**
 * `slideCount` off an untyped JSON body, made safe to draw with. Anything that
 * is not a whole number >= 1 degrades to 1 — the single-photo case — because a
 * bad count must cost the carousel, never the photo.
 */
function readSlideCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const whole = Math.floor(value);
  return whole < 1 ? 1 : whole;
}

/**
 * Mint slide 0 + read `slideCount` for a list of post ids via the BFF.
 * Returns postId → { mediaUrl, slideCount }. Never throws on 5xx/network
 * (empty/partial Map) EXCEPT 402, which MUST throw PostMediaError('gated').
 *
 * ONE request per 50 ids, which is what keeps a feed page to a single batch
 * call. The slide count rides along in that same response rather than costing a
 * second round trip (ENG-809 decision 3).
 */
export async function fetchPostMediaItems(postIds: string[]): Promise<Map<string, PostMediaItem>> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of postIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const out = new Map<string, PostMediaItem>();
  if (unique.length === 0) return out;

  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    try {
      const res = await fetch("/api/posts/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Post IDS ONLY. Adding a path here would hand the server something the
        // caller controls; it ignores `path`/`paths` for exactly that reason,
        // and this end must not start sending one either.
        body: JSON.stringify({ postIds: chunk }),
      });
      if (res.status === 402) throw new PostMediaError("gated");
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      const items = json?.data?.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const postId = (item as { postId?: unknown })?.postId;
        const mediaUrl = (item as { mediaUrl?: unknown })?.mediaUrl;
        if (typeof postId === "string" && typeof mediaUrl === "string" && mediaUrl.length > 0) {
          out.set(postId, {
            mediaUrl,
            slideCount: readSlideCount((item as { slideCount?: unknown })?.slideCount),
          });
        }
      }
    } catch (e) {
      if (e instanceof PostMediaError) throw e;
      // Network throw → empty contribution for this chunk.
    }
  }
  return out;
}

/**
 * The url-only view of the batch, for callers that draw one image and no dots
 * (the ENG-813 re-mint path). Same single request, same 402 contract.
 */
export async function fetchPostMedia(postIds: string[]): Promise<Map<string, string>> {
  const items = await fetchPostMediaItems(postIds);
  const out = new Map<string, string>();
  for (const [id, item] of items) out.set(id, item.mediaUrl);
  return out;
}

/**
 * Mint ONE slide of one post, addressed as `{ postId, slideIndex }` — never as
 * a path (ENG-809 decision 2). This is the whole carousel read path: slides 1+
 * exist nowhere else, since ENG-800 revoked member SELECT on the bucket.
 *
 * NULL ON EVERYTHING, 402 INCLUDED. A draft's slide, an index past the end, a
 * gap in `sort_order`, a lapsed subscription and a dead network all return the
 * same `null`, which the carousel draws as a blank slide. Two reasons, and both
 * are load-bearing:
 *   - the server already refuses all of those identically, so surfacing them
 *     differently here would re-create the existence leak it closed;
 *   - a 402 must fall back to the placeholder, never to gated bytes and never to
 *     a wall raised by an <img> (guardrail 3). The SCREEN owns the wall, and its
 *     batch call — which does throw on 402 — is what raises it.
 */
export async function fetchPostMediaSlide(
  postId: string,
  slideIndex: number,
): Promise<string | null> {
  if (!postId) return null;
  // Refused without a request: the be answers an out-of-range index with a 400,
  // so asking would only spend a round trip to be told what is known here.
  if (!Number.isInteger(slideIndex) || slideIndex < 0 || slideIndex > MAX_SLIDE_INDEX) return null;
  try {
    const res = await fetch("/api/posts/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The ENTIRE body. A post id and an ordinal — no path, no bucket, no
      // storage key of any kind.
      body: JSON.stringify({ postId, slideIndex }),
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const mediaUrl = json?.data?.mediaUrl;
    return typeof mediaUrl === "string" && mediaUrl.length > 0 ? mediaUrl : null;
  } catch {
    return null;
  }
}

type DisplayRow = {
  id: string;
  type?: string | null;
  poster_url?: string | null;
  media_url?: string | null;
};

/**
 * Resolve display images for a page of posts, plus each post's slide count.
 * - Absolute URL → passthrough keyed by post id
 * - Video with a poster key → GET playback?posterOnly=1 (no Mux stream)
 * - Photo/other with a non-absolute key → ONE batched fetchPostMediaItems
 * - Voice with no poster / text with no media → skip
 *
 * The slide counts come out of that SAME batch response — no second call, and
 * nothing per post — which is what lets a carousel draw the right number of dots
 * on first paint (ENG-809 decision 3). A post absent from `slideCounts` is the
 * legacy single-photo case and draws no carousel at all.
 */
export async function resolvePostDisplayUrls(
  rows: { id: string; type?: string | null; poster_url?: string | null; media_url?: string | null }[],
): Promise<PostDisplayMedia> {
  const out = new Map<string, string>();
  const slideCounts = new Map<string, number>();
  const photoIds: string[] = [];
  const videoIds: string[] = [];

  for (const row of rows as DisplayRow[]) {
    const key = postPosterKey(row);
    if (key && isAbsoluteUrl(key)) {
      out.set(row.id, key);
      continue;
    }
    // Voice audio is not a list poster; only mint if a baked poster exists.
    if (row.type === "voice" && !row.poster_url) continue;
    if (!key) continue;
    if (row.type === "video") videoIds.push(row.id);
    else photoIds.push(row.id);
  }

  const photos = await fetchPostMediaItems(photoIds);
  for (const [id, item] of photos) {
    out.set(id, item.mediaUrl);
    slideCounts.set(id, item.slideCount);
  }

  await Promise.all(
    videoIds.map(async (id) => {
      try {
        const res = await fetch(`/api/posts/${id}/playback?posterOnly=1`);
        if (res.status === 402) throw new PostMediaError("gated");
        if (!res.ok) return;
        const json = await res.json().catch(() => null);
        const posterUrl = json?.data?.posterUrl;
        if (typeof posterUrl === "string" && posterUrl.length > 0) out.set(id, posterUrl);
      } catch (e) {
        if (e instanceof PostMediaError) throw e;
        // Network / parse failure → skip this id (placeholder).
      }
    }),
  );

  return { urls: out, slideCounts };
}

/**
 * Re-mint the display URL for ONE post — the recovery path behind an <img>
 * onError (ENG-813). A minted URL lives 300s; the element failing to load IS
 * the expiry signal, so nothing here consults a clock. Requests only `postId`,
 * never the page.
 *
 * Returns null on any failure, INCLUDING 402: a lapsed subscription must fall
 * back to the placeholder, never to gated bytes (guardrail 3). The screen's own
 * gate — not an <img> — owns the reactivate wall.
 *
 * `slideIndex` (ENG-815) picks WHICH slide to re-mint. Omitted or 0 is the
 * post's own media — the batch path every single-photo and video card takes,
 * unchanged. A carousel slide passes its ordinal, because re-minting the batch
 * for slide 3 would hand it slide 0's url: a silent photo swap on expiry, which
 * is worse than the black box ENG-813 removed.
 */
export async function remintPostMedia(
  postId: string,
  opts?: { video?: boolean; slideIndex?: number },
): Promise<string | null> {
  if (!postId) return null;
  const slideIndex = opts?.slideIndex ?? 0;
  // Slides 1+ live only behind the by-index mode; `post.media_url` mirrors slide
  // 0, so index 0 keeps using the batch (one shape for the common case).
  if (!opts?.video && slideIndex > 0) return fetchPostMediaSlide(postId, slideIndex);
  if (opts?.video) {
    try {
      // `cache: "no-store"` is load-bearing, not hygiene. This is the SAME URL
      // the page's initial resolve already fetched, so a cached 200 would hand
      // back the very poster that just failed — turning the one retry into a
      // guaranteed no-op AND skipping the server's re-gate. The whole bug is
      // that expired bytes survive in the HTTP cache; do not re-introduce it
      // on the recovery path.
      const res = await fetch(
        `/api/posts/${encodeURIComponent(postId)}/playback?posterOnly=1`,
        { cache: "no-store" },
      );
      if (!res.ok) return null;
      const json = await res.json().catch(() => null);
      const posterUrl = json?.data?.posterUrl;
      return typeof posterUrl === "string" && posterUrl.length > 0 ? posterUrl : null;
    } catch {
      return null;
    }
  }
  try {
    const minted = await fetchPostMedia([postId]);
    return minted.get(postId) ?? null;
  } catch {
    // PostMediaError('gated') included — placeholder, never gated bytes.
    return null;
  }
}
