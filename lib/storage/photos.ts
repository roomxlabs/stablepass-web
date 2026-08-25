import type { SupabaseClient } from "@supabase/supabase-js";

// Photos and post images live in PRIVATE Storage buckets (guardrail #8), so they
// can only be displayed through short-lived SIGNED URLs — never a public URL.
// The admin app stores the bare object *path* in `photo_url` / `media_url`
// (see stablepass-admin `lib/storage/photos.ts`), so every display surface here
// must turn that path into a signed URL at render time with these helpers.
//
// Rendering a stored path straight into `<img src>` does NOT merely fail to
// load: a bare path is a RELATIVE URL, so the browser resolves it against the
// current page (`/trainers/<id>/ilham-123.jpg`) and silently gets HTML back.
//
// Signing runs as the CALLER (supabaseServer in Server Components / BFF routes,
// supabaseBrowser in client islands) — never the service role. The backend
// policy `media gated read` (authenticated AND has_content_access) is the real
// boundary, so a lapsed member cannot mint a URL for gated media.
//
// After ENG-799, post-media BYTES are minted by `lib/api/post-media.ts` (BFF →
// edge). `signPhoto` / `signPhotoMap` keep serving horse-photos and
// trainer-photos; post-media paths are deny-by-construction (absolute URLs
// still passthrough).
export const HORSE_PHOTO_BUCKET = "horse-photos";
export const TRAINER_PHOTO_BUCKET = "trainer-photos";
export const POST_MEDIA_BUCKET = "post-media";

// 1 hour: long enough for a page/session, short enough that a leaked URL expires.
export const PHOTO_SIGN_TTL = 3600;

// A stored value is normally a bare object path. Defensively pass through an
// already-absolute URL (legacy rows, seeded fixtures, brand assets) untouched
// instead of trying to sign it as a path.
const isAbsoluteUrl = (v: string): boolean => /^(https?:|blob:|data:)/i.test(v);

// Sign a single stored photo value for display. Returns null when there is
// nothing to show or signing fails (missing object / RLS), so callers fall back
// to a placeholder rather than rendering a broken image.
export async function signPhoto(
  sb: SupabaseClient,
  bucket: string,
  value: string | null | undefined,
  ttl: number = PHOTO_SIGN_TTL,
): Promise<string | null> {
  if (!value) return null;
  if (isAbsoluteUrl(value)) return value;
  // Deny-by-construction: post-media paths are minted via /api/posts/media.
  if (bucket === POST_MEDIA_BUCKET) return null;
  const { data } = await sb.storage.from(bucket).createSignedUrl(value, ttl);
  return data?.signedUrl ?? null;
}

// A post's display image: the baked video poster if one exists, otherwise the
// photo. `poster_url` is written by the backend's mux-webhook on video.asset.ready
// (BE migration 20260728120000) and, like `media_url`, is a bare object path in the
// private `post-media` bucket — minted via the post-media BFF for photos, or
// playback?posterOnly=1 for video posters.
//
// Before this existed a video post had NOTHING to show: `media_url` is the
// photo/voice path and is null for video, so every video card fell through to an
// empty box over the dark-green background.
export function postPosterKey(
  row: { poster_url?: string | null; media_url?: string | null },
): string | null {
  return row.poster_url ?? row.media_url ?? null;
}

/** Resolve a post row to its signed poster URL using an already-built sign map.
 * Lookup: absolute key passthrough; post-id key (post-media mint); else path key
 * (horse/trainer maps). */
export function signedPosterFor(
  row: { id?: string; poster_url?: string | null; media_url?: string | null },
  signed: Map<string, string>,
): string | null {
  const key = postPosterKey(row);
  if (key && isAbsoluteUrl(key)) return signed.get(key) ?? key;
  if (row.id && signed.has(row.id)) return signed.get(row.id) ?? null;
  return key ? (signed.get(key) ?? null) : null;
}

// Batch variant: one round-trip for a list. Returns a `value -> signed URL` map
// keyed by the ORIGINAL stored value, so a caller can look each row's value up
// directly. Distinct paths only; absolute URLs map to themselves.
export async function signPhotoMap(
  sb: SupabaseClient,
  bucket: string,
  values: ReadonlyArray<string | null | undefined>,
  ttl: number = PHOTO_SIGN_TTL,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const paths: string[] = [];
  for (const v of values) {
    if (!v) continue;
    if (isAbsoluteUrl(v)) out.set(v, v);
    else if (!out.has(v) && !paths.includes(v)) paths.push(v);
  }
  if (paths.length === 0) return out;
  // Deny-by-construction: post-media bytes are minted by lib/api/post-media.ts.
  if (bucket === POST_MEDIA_BUCKET) return out;
  const { data } = await sb.storage.from(bucket).createSignedUrls(paths, ttl);
  for (const item of data ?? []) {
    if (item.path && item.signedUrl) out.set(item.path, item.signedUrl);
  }
  return out;
}
