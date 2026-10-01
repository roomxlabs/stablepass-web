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
//   200 { data: { items: [{ postId, mediaUrl, slideCount }
//                        | { postId, videoCount, posterUrl, posterExpiresAt }], expiresAt } }
//       (a VIDEO post's item carries `videoCount` — its READY videos — and no
//        media url; ENG-1596. Since ENG-1629 it also carries its slot-0 baked
//        POSTER, signed with the batch (`null` when there is none). A video post
//        with nothing playable is absent.)
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
import { apiFetch } from "@/lib/api/client";

const BATCH = 50;

/**
 * The be's own bound on an addressable slide ordinal (`MAX_SLIDE_INDEX` in
 * `supabase/functions/post-media/index.ts`, mirroring the table's
 * `sort_order between 0 and 9` CHECK). Asking outside it is a 400 there, so it
 * is refused here without a request.
 */
const MAX_SLIDE_INDEX = 9;

/**
 * The be's bound on an addressable video ordinal (`MAX_VIDEO_INDEX` in
 * `supabase/functions/playback/index.ts`, mirroring `post_video`'s
 * `sort_order between 0 and 4` CHECK — ENG-1596). A multi-video post carries
 * at most five videos; asking outside it is a 400 there, so it is refused here
 * without a request.
 */
export const MAX_VIDEO_INDEX = 4;

/** Is `i` a video ordinal the be will address (0..4, an integer)? */
export function isVideoIndex(i: unknown): i is number {
  return typeof i === "number" && Number.isInteger(i) && i >= 0 && i <= MAX_VIDEO_INDEX;
}

/**
 * The playback route for one video of a post. Index 0 keeps the EXACT url every
 * caller used before ENG-1599 (the be defaults an omitted `videoIndex` to 0), so
 * a single-video post's mint — and every test that matches it — is unchanged.
 * The client names a post and an ordinal; it never sends an id or a path.
 */
export function playbackPath(postId: string, videoIndex = 0, opts?: { posterOnly?: boolean }): string {
  const params = new URLSearchParams();
  if (opts?.posterOnly) params.set("posterOnly", "1");
  if (videoIndex !== 0) params.set("videoIndex", String(videoIndex));
  const qs = params.toString();
  return `/api/posts/${encodeURIComponent(postId)}/playback${qs ? `?${qs}` : ""}`;
}

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
  /**
   * `post id -> the batch's media count`: `slideCount` for a photo post, and
   * `videoCount` (its READY videos, ENG-1596) for a video post. One map rather
   * than two because a post has exactly one media type, and `postIntrinsics`
   * splits it by `post.type` — which is what keeps every screen that already
   * threads this map (explore-page, the four profile/list feeds) carrying the
   * video count without a second plumbing change. Absent means the single-
   * photo / single-video case.
   */
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

/**
 * HOW a mint request reaches the be (ENG-1593). The browser goes through the
 * BFF (`/api/posts/media`, `/api/posts/:id/playback`); the server-rendered
 * first page of /explore calls the edge functions directly with the member's
 * own session (`lib/api/post-media-server.ts`). Both answer with the SAME
 * `{ data }` body and the SAME 402 for a lapsed member, which is what lets the
 * parsing, the gate handling and the post-id-only addressing below stay in ONE
 * place for both callers.
 *
 * Neither method takes a path: the only inputs are post ids.
 */
export interface PostMediaTransport {
  /** The batch mint for up to 50 post ids — `{ postIds }`, nothing else. */
  batch(postIds: string[]): Promise<Response>;
  /** One video post's baked poster only (no stream mint). */
  poster(postId: string): Promise<Response>;
}

/** The browser's transport: through the BFF, via `apiFetch` (401 eviction). */
export const bffPostMediaTransport: PostMediaTransport = {
  batch: (postIds) =>
    apiFetch("/api/posts/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Post IDS ONLY. Adding a path here would hand the server something the
      // caller controls; it ignores `path`/`paths` for exactly that reason,
      // and this end must not start sending one either.
      body: JSON.stringify({ postIds }),
    }),
  poster: (postId) => apiFetch(`/api/posts/${postId}/playback?posterOnly=1`),
};

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

/** What one batch call returns: photo items, and video posts' counts. */
interface PostMediaBatch {
  items: Map<string, PostMediaItem>;
  /** `post id -> videoCount` for the VIDEO posts in the batch (ENG-1596). */
  videoCounts: Map<string, number>;
  /**
   * `post id -> slot-0 poster url` for the VIDEO posts whose batch item carried
   * one (ENG-1629, PF-B2). ABSENT — not null — for a video post the be could not
   * sign a poster for (no baked poster, slot 0 not ready, a legacy row-less
   * post): that absence is exactly what sends the caller to `posterOnly`.
   */
  videoPosters: Map<string, string>;
}

/**
 * The batch mint for a list of post ids — ONE request per 50 ids. Photo items
 * come back as `{ mediaUrl, slideCount }`; a video post's item (ENG-1596) is
 * `{ postId, videoCount }` with no url, and lands in `videoCounts`. Never throws
 * on 5xx/network (empty/partial maps) EXCEPT 402, which MUST throw
 * PostMediaError('gated').
 */
async function fetchPostMediaBatch(
  postIds: string[],
  transport: PostMediaTransport,
): Promise<PostMediaBatch> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of postIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const out: PostMediaBatch = { items: new Map(), videoCounts: new Map(), videoPosters: new Map() };
  if (unique.length === 0) return out;

  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    try {
      const res = await transport.batch(chunk);
      if (res.status === 402) throw new PostMediaError("gated");
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      const items = json?.data?.items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const postId = (item as { postId?: unknown })?.postId;
        if (typeof postId !== "string") continue;
        const mediaUrl = (item as { mediaUrl?: unknown })?.mediaUrl;
        const videoCount = (item as { videoCount?: unknown })?.videoCount;
        if (typeof mediaUrl === "string" && mediaUrl.length > 0) {
          out.items.set(postId, {
            mediaUrl,
            slideCount: readSlideCount((item as { slideCount?: unknown })?.slideCount),
          });
        } else if (videoCount !== undefined) {
          out.videoCounts.set(postId, readSlideCount(videoCount));
          // The be signs this with the batch (300 s, like every url in it) and
          // never passes an absolute stored value through, so it is a minted url
          // or null — `null`/missing/garbage all leave the post to `posterOnly`.
          const posterUrl = (item as { posterUrl?: unknown })?.posterUrl;
          if (typeof posterUrl === "string" && posterUrl.length > 0) out.videoPosters.set(postId, posterUrl);
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
 * Mint slide 0 + read `slideCount` for a list of post ids via the BFF.
 * Returns postId → { mediaUrl, slideCount }. Never throws on 5xx/network
 * (empty/partial Map) EXCEPT 402, which MUST throw PostMediaError('gated').
 *
 * ONE request per 50 ids, which is what keeps a feed page to a single batch
 * call. The slide count rides along in that same response rather than costing a
 * second round trip (ENG-809 decision 3). A video post's `{ postId, videoCount }`
 * item has no url and is not in this map — `resolvePostDisplayUrls` reads it.
 */
export async function fetchPostMediaItems(
  postIds: string[],
  transport: PostMediaTransport = bffPostMediaTransport,
): Promise<Map<string, PostMediaItem>> {
  return (await fetchPostMediaBatch(postIds, transport)).items;
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
    const res = await apiFetch("/api/posts/media", {
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
 * - Video → its slot-0 poster from the SAME batch (ENG-1629 `posterUrl`); only
 *   a video post with a poster key whose batch item came back WITHOUT one falls
 *   back to GET playback?posterOnly=1 (no Mux stream) — ENG-1633
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
  transport: PostMediaTransport = bffPostMediaTransport,
): Promise<PostDisplayMedia> {
  const out = new Map<string, string>();
  const slideCounts = new Map<string, number>();
  const photoIds: string[] = [];
  const videoIds: string[] = [];
  // ENG-1599 — every VIDEO post also rides in the batch, for its `videoCount`
  // (ENG-1596). It is the same single request the photos already make, so a
  // page costs no extra round trip for it unless it has no photos at all.
  const countIds: string[] = [];

  for (const row of rows as DisplayRow[]) {
    if (row.type === "video") countIds.push(row.id);
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

  // ONE request for the page (ENG-1633). Since ENG-1629 the batch signs every
  // video post's slot-0 poster alongside the photos, so a page of N video posts
  // no longer costs N `posterOnly` round trips — it costs none. A 402 still
  // rejects the lot with PostMediaError('gated'), exactly as before, so a lapsed
  // member's page carries no poster url at all (guardrail 3).
  const batch = await fetchPostMediaBatch([...photoIds, ...countIds], transport);
  for (const [id, url] of batch.videoPosters) out.set(id, url);

  // The FALLBACK, per post, only where the batch had no poster to give: a legacy
  // row-less video post, a slot 0 still encoding, or a batch that failed outright
  // (5xx / network — which never throws). This is the pre-ENG-1633 path,
  // unchanged, for exactly the posts the new keys cannot serve.
  const fallbackIds = videoIds.filter((id) => !batch.videoPosters.has(id));
  await Promise.all(
    fallbackIds.map(async (id) => {
      try {
        const res = await transport.poster(id);
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
  for (const [id, item] of batch.items) {
    out.set(id, item.mediaUrl);
    slideCounts.set(id, item.slideCount);
  }
  // A video post's count shares the map (see `PostDisplayMedia.slideCounts`).
  // It never overwrites a url: a video item carries none.
  for (const [id, count] of batch.videoCounts) slideCounts.set(id, count);

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
  opts?: { video?: boolean; slideIndex?: number; videoIndex?: number },
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
      //
      // `videoIndex` (ENG-1599) re-mints the poster of THAT video of a multi-
      // video post — index 0 keeps the exact url a single-video card always used.
      const videoIndex = opts?.videoIndex ?? 0;
      if (!isVideoIndex(videoIndex)) return null;
      const res = await apiFetch(playbackPath(postId, videoIndex, { posterOnly: true }), {
        cache: "no-store",
      });
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

/**
 * What minting one video's poster came back as (ENG-1599).
 *   - `ok`      — the poster url (may be null: a video with no baked poster yet)
 *   - `missing` — 404: nothing playable at this index (still encoding after an
 *                 admin edit). The carousel HIDES the slide rather than drawing
 *                 a dead one; `videoCount` counts ready rows, so this is rare.
 *   - `refused` — anything else, 402 INCLUDED: no poster, and no wall raised
 *                 by an image (guardrail 3) — the screen's own gate owns that.
 */
export type VideoPosterResult =
  | { kind: "ok"; url: string | null }
  | { kind: "missing" }
  | { kind: "refused" };

/**
 * Mint the poster of ONE video of a post, addressed as `{ postId, videoIndex }`
 * through `GET /api/posts/:id/playback?posterOnly=1&videoIndex=i` — the poster
 * half of the be's re-gated mint, never a stream url and never a path.
 */
export async function fetchVideoPoster(postId: string, videoIndex: number): Promise<VideoPosterResult> {
  if (!postId || !isVideoIndex(videoIndex)) return { kind: "refused" };
  try {
    const res = await apiFetch(playbackPath(postId, videoIndex, { posterOnly: true }));
    if (res.status === 404) return { kind: "missing" };
    if (!res.ok) return { kind: "refused" };
    const json = await res.json().catch(() => null);
    const posterUrl = json?.data?.posterUrl;
    return { kind: "ok", url: typeof posterUrl === "string" && posterUrl.length > 0 ? posterUrl : null };
  } catch {
    return { kind: "refused" };
  }
}
