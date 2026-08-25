// Client-island fetcher for POST /api/posts/media — the ONLY way a member
// island obtains a photo/voice display URL from the private post-media bucket
// after ENG-799. Browser never talks to the edge function or signs a path.
//
// Contract (BFF → be post-media):
//   POST { postIds: string[] }            1..50, never a path
//   200 { data: { items: [{ postId, mediaUrl }], expiresAt } }
//   402 → PostMediaError('gated')         reactivate wall (must not silent-empty)
//   other non-ok / network → empty Map    placeholder, never a crash
//
// A post id ABSENT from items (draft/unpublished) is absent from the Map —
// ordinary placeholder, no error copy.
import { postPosterKey } from "@/lib/storage/photos";

const BATCH = 50;

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
 * Mint signed photo/voice URLs for a list of post ids via the BFF.
 * Returns postId → url. Never throws on 5xx/network (empty/partial Map) EXCEPT
 * 402, which MUST throw PostMediaError('gated').
 */
export async function fetchPostMedia(postIds: string[]): Promise<Map<string, string>> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of postIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }
  const out = new Map<string, string>();
  if (unique.length === 0) return out;

  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    try {
      const res = await fetch("/api/posts/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
          out.set(postId, mediaUrl);
        }
      }
    } catch (e) {
      if (e instanceof PostMediaError) throw e;
      // Network throw → empty contribution for this chunk.
    }
  }
  return out;
}

type DisplayRow = {
  id: string;
  type?: string | null;
  poster_url?: string | null;
  media_url?: string | null;
};

/**
 * Resolve display images for a page of posts.
 * - Absolute URL → passthrough keyed by post id
 * - Video with a poster key → GET playback?posterOnly=1 (no Mux stream)
 * - Photo/other with a non-absolute key → batched fetchPostMedia
 * - Voice with no poster / text with no media → skip
 */
export async function resolvePostDisplayUrls(
  rows: { id: string; type?: string | null; poster_url?: string | null; media_url?: string | null }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
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

  const photos = await fetchPostMedia(photoIds);
  for (const [id, url] of photos) out.set(id, url);

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

  return out;
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
 */
export async function remintPostMedia(
  postId: string,
  opts?: { video?: boolean },
): Promise<string | null> {
  if (!postId) return null;
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
