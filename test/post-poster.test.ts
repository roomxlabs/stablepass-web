import { describe, it, expect } from "vitest";
import { postPosterKey, signedPosterFor } from "@/lib/storage/photos";

// A video post carries no media_url (that column is the photo/voice path), so before
// poster_url existed every video rendered as an empty box over the dark-green
// background. These pin the precedence and the null-safety of the fallback.
describe("postPosterKey", () => {
  it("prefers the baked video poster over media_url", () => {
    expect(postPosterKey({ poster_url: "posters/p1.jpg", media_url: "media/p1.jpg" })).toBe("posters/p1.jpg");
  });

  it("falls back to media_url for a photo post", () => {
    expect(postPosterKey({ poster_url: null, media_url: "media/p1.jpg" })).toBe("media/p1.jpg");
  });

  it("returns null for a video whose poster has not been baked yet", () => {
    // The pre-existing empty-media fallback must still kick in, not a broken <img>.
    expect(postPosterKey({ poster_url: null, media_url: null })).toBeNull();
  });

  it("tolerates a row without the column at all (older BFF payloads)", () => {
    expect(postPosterKey({ media_url: "media/p1.jpg" })).toBe("media/p1.jpg");
    expect(postPosterKey({})).toBeNull();
  });
});

describe("signedPosterFor", () => {
  it("resolves post-media by post id (ENG-799 mint map)", () => {
    const signed = new Map([["p1", "https://signed/by-id"]]);
    expect(signedPosterFor({ id: "p1", poster_url: null, media_url: "media/p1.jpg" }, signed))
      .toBe("https://signed/by-id");
  });

  it("still resolves horse/trainer values by path", () => {
    const signed = new Map([
      ["posters/p1.jpg", "https://signed/poster"],
      ["media/p1.jpg", "https://signed/photo"],
    ]);
    expect(signedPosterFor({ poster_url: "posters/p1.jpg", media_url: "media/p1.jpg" }, signed))
      .toBe("https://signed/poster");
    expect(signedPosterFor({ poster_url: null, media_url: "media/p1.jpg" }, signed))
      .toBe("https://signed/photo");
  });

  it("passes an absolute key through when the map has no entry", () => {
    expect(
      signedPosterFor({ id: "p1", poster_url: "https://placehold.co/x", media_url: null }, new Map()),
    ).toBe("https://placehold.co/x");
  });

  it("prefers post id over path when both are present", () => {
    const signed = new Map([
      ["p1", "https://signed/by-id"],
      ["media/p1.jpg", "https://signed/by-path"],
    ]);
    expect(signedPosterFor({ id: "p1", poster_url: null, media_url: "media/p1.jpg" }, signed))
      .toBe("https://signed/by-id");
  });

  it("returns null rather than a bare path when signing missed", () => {
    // A bare path in <img src> resolves RELATIVE to the page and silently loads HTML.
    expect(signedPosterFor({ poster_url: "posters/unsigned.jpg", media_url: null }, new Map())).toBeNull();
  });

  it("returns null when there is nothing to show", () => {
    expect(signedPosterFor({ poster_url: null, media_url: null }, new Map())).toBeNull();
  });
});
