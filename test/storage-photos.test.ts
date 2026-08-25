import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  signPhoto,
  signPhotoMap,
  HORSE_PHOTO_BUCKET,
  TRAINER_PHOTO_BUCKET,
  POST_MEDIA_BUCKET,
  PHOTO_SIGN_TTL,
} from "@/lib/storage/photos";

// Photos live in PRIVATE buckets and the admin app stores a BARE OBJECT PATH in
// `photo_url` / `media_url`. Rendering that path raw is the bug this module
// exists to prevent: a bare path is a RELATIVE URL, so the browser resolves it
// against the current page and gets HTML instead of an image.
function makeSb(overrides: {
  signed?: string | null;
  signedList?: Array<{ path: string | null; signedUrl: string }>;
} = {}) {
  const createSignedUrl = vi.fn(async () =>
    overrides.signed === null ? { data: null } : { data: { signedUrl: overrides.signed ?? "https://sb.local/signed?token=abc" } },
  );
  const createSignedUrls = vi.fn(async (paths: string[]) => ({
    data: overrides.signedList ?? paths.map((p) => ({ path: p, signedUrl: `https://sb.local/${p}?token=abc` })),
  }));
  const from = vi.fn(() => ({ createSignedUrl, createSignedUrls }));
  return { sb: { storage: { from } } as unknown as SupabaseClient, from, createSignedUrl, createSignedUrls };
}

describe("signPhoto", () => {
  it("signs a bare storage path (the admin-upload shape) instead of returning it raw", async () => {
    const { sb, from, createSignedUrl } = makeSb();
    const out = await signPhoto(sb, TRAINER_PHOTO_BUCKET, "ilham-1785164320876.jpg");

    expect(from).toHaveBeenCalledWith(TRAINER_PHOTO_BUCKET);
    expect(createSignedUrl).toHaveBeenCalledWith("ilham-1785164320876.jpg", PHOTO_SIGN_TTL);
    expect(out).toBe("https://sb.local/signed?token=abc");
    // The regression guard: the stored path must never survive to the caller.
    expect(out).not.toBe("ilham-1785164320876.jpg");
  });

  it("passes an already-absolute URL through untouched, without calling storage", async () => {
    const { sb, createSignedUrl } = makeSb();
    expect(await signPhoto(sb, HORSE_PHOTO_BUCKET, "https://placehold.co/800x450")).toBe("https://placehold.co/800x450");
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("returns null for null/empty so callers render their placeholder", async () => {
    const { sb, createSignedUrl } = makeSb();
    expect(await signPhoto(sb, POST_MEDIA_BUCKET, null)).toBeNull();
    expect(await signPhoto(sb, POST_MEDIA_BUCKET, undefined)).toBeNull();
    expect(await signPhoto(sb, POST_MEDIA_BUCKET, "")).toBeNull();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("returns null when signing fails (missing object / RLS denies) rather than a broken src", async () => {
    const { sb } = makeSb({ signed: null });
    expect(await signPhoto(sb, TRAINER_PHOTO_BUCKET, "gone.jpg")).toBeNull();
  });

  it("never signs a post-media path — deny-by-construction (ENG-799)", async () => {
    const { sb, createSignedUrl, from } = makeSb();
    expect(await signPhoto(sb, POST_MEDIA_BUCKET, "media/p1.jpg")).toBeNull();
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("still passes absolute URLs on post-media without createSignedUrl", async () => {
    const { sb, createSignedUrl } = makeSb();
    expect(await signPhoto(sb, POST_MEDIA_BUCKET, "https://placehold.co/800x450")).toBe(
      "https://placehold.co/800x450",
    );
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});

describe("signPhotoMap", () => {
  it("batches distinct paths into ONE round-trip and keys the map by the stored value", async () => {
    const { sb, createSignedUrls } = makeSb();
    const map = await signPhotoMap(sb, HORSE_PHOTO_BUCKET, ["a.jpg", "b.jpg", "a.jpg", null, undefined]);

    expect(createSignedUrls).toHaveBeenCalledTimes(1);
    expect(createSignedUrls).toHaveBeenCalledWith(["a.jpg", "b.jpg"], PHOTO_SIGN_TTL);
    expect(map.get("a.jpg")).toBe("https://sb.local/a.jpg?token=abc");
    expect(map.get("b.jpg")).toBe("https://sb.local/b.jpg?token=abc");
  });

  it("maps absolute URLs on post-media and never signs paths (ENG-799)", async () => {
    const { sb, createSignedUrls, from } = makeSb();
    const map = await signPhotoMap(sb, POST_MEDIA_BUCKET, ["https://placehold.co/800x450", "real-path.jpg"]);

    expect(createSignedUrls).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
    expect(map.get("https://placehold.co/800x450")).toBe("https://placehold.co/800x450");
    expect(map.has("real-path.jpg")).toBe(false);
  });

  it("skips storage entirely when there is nothing to sign", async () => {
    const { sb, createSignedUrls } = makeSb();
    const map = await signPhotoMap(sb, POST_MEDIA_BUCKET, [null, undefined, ""]);
    expect(createSignedUrls).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it("omits paths storage could not sign, so the caller falls back to a placeholder", async () => {
    const { sb } = makeSb({ signedList: [{ path: "ok.jpg", signedUrl: "https://sb.local/ok.jpg?token=abc" }] });
    const map = await signPhotoMap(sb, HORSE_PHOTO_BUCKET, ["ok.jpg", "denied.jpg"]);
    expect(map.get("ok.jpg")).toBeTruthy();
    expect(map.has("denied.jpg")).toBe(false);
  });

  it("still signs horse and trainer buckets directly", async () => {
    const { sb, from, createSignedUrls } = makeSb();
    await signPhotoMap(sb, TRAINER_PHOTO_BUCKET, ["t.jpg"]);
    expect(from).toHaveBeenCalledWith(TRAINER_PHOTO_BUCKET);
    expect(createSignedUrls).toHaveBeenCalledWith(["t.jpg"], PHOTO_SIGN_TTL);
  });
});
