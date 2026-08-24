// ENG-794 — the shared post-intrinsics row type, mapper and projection
// (lib/feed/post-row.ts).
//
// This file is the gate on the collapse. Three tickets in a row (ENG-761,
// ENG-772, ENG-775) shipped a `post` column that reached the BFF and was then
// dropped one layer later, each time in a hand-copied per-screen mapper. The
// point of the module under test is that there is now ONE mapper and ONE
// projection, so the assertions below are deliberately structural: they pin the
// exact projection string and the exact KEY SET the mapper emits, not just a
// couple of sample values.
import { describe, it, expect } from "vitest";
import {
  POST_INTRINSIC_COLUMNS,
  postIntrinsics,
  relativeTime,
  type PostIntrinsicRow,
  type PostIntrinsics,
  type PostIntrinsicsContext,
} from "@/lib/feed/post-row";
import type { PostPhoto, ReactionEmoji } from "@/components/types";

// ── Type-level guard, the same trick as ENG-785's `LabelIsRequired` ──────────
// `PostIntrinsics` is `Required<Pick<FeedPost, …>>`, and the `Required` is the
// whole mechanism: three of those keys (`title?`, `body?`, `photos?`) are
// OPTIONAL on `FeedPost`, so a plain `Pick` would let the shared mapper quietly
// omit one and still compile — exactly the bug class this ticket removes.
// `T extends Required<T>` holds only when no key of T is optional, so relaxing
// the type collapses this to `never` and fails the build.
type EveryKeyRequired<T> = T extends Required<T> ? true : never;
const _everyIntrinsicIsRequired: EveryKeyRequired<PostIntrinsics> = true;
void _everyIntrinsicIsRequired;

/** The ten card fields the shared mapper owns. Sorted, for a stable compare. */
const INTRINSIC_KEYS = [
  "body",
  "count",
  "id",
  "label",
  "media",
  "photos",
  "postedAgo",
  "reacted",
  "title",
  "watermarked",
].sort();

function row(over: Partial<PostIntrinsicRow> = {}): PostIntrinsicRow {
  return {
    id: "p1",
    type: "photo",
    title: "Gallop this morning",
    body: "Went well.",
    label: "Trackwork",
    media_url: "p1/original",
    poster_url: null,
    aspect_ratio: 1.5,
    watermarked: true,
    like_count: 7,
    published_at: new Date().toISOString(),
    ...over,
  };
}

function ctx(over: Partial<PostIntrinsicsContext> = {}): PostIntrinsicsContext {
  return {
    signedMedia: new Map<string, string>([["p1/original", "https://signed/p1"]]),
    photosByPost: new Map<string, PostPhoto[]>(),
    reactionByPost: new Map<string, ReactionEmoji>(),
    ...over,
  };
}

describe("POST_INTRINSIC_COLUMNS", () => {
  // `.toBe`, not `.toContain`: `sb` is untyped so `tsc` proves nothing about a
  // projection, and BOTH directions fail SILENTLY. Too narrow starves the card
  // (how `label` went missing on both profile feeds, ENG-772). Too wide names an
  // undeployed column, PostgREST rejects the WHOLE query with 42703/400, the
  // routes destructure only `data`, and the screens render "No updates yet" — a
  // total content blackout that looks exactly like an empty stable.
  it("pins the EXACT shared post projection", () => {
    expect(POST_INTRINSIC_COLUMNS).toBe(
      "id, type, title, body, label, media_url, poster_url, mux_playback_id, aspect_ratio, watermarked, like_count, published_at",
    );
  });

  // Ties the projection to the row type. Adding a column to one without the
  // other is the drift this ticket exists to prevent, and it is invisible to
  // `tsc`. `mux_playback_id` is the one deliberate exception: both routes have
  // always selected it and no mapper reads it, so it is carried to keep the two
  // pinned route projections byte-identical.
  it("selects exactly the columns the row type declares, plus mux_playback_id", () => {
    const selected = POST_INTRINSIC_COLUMNS.split(",").map((c) => c.trim()).sort();
    const declared = Object.keys(row()).sort();
    expect(selected).toEqual([...declared, "mux_playback_id"].sort());
  });
});

describe("postIntrinsics", () => {
  // The house gotcha: `undefined` values vanish from a JSON response and
  // per-field assertions miss a dropped key entirely. Pin the SET.
  it("emits exactly the ten intrinsic keys — no more, no fewer", () => {
    expect(Object.keys(postIntrinsics(row(), ctx())).sort()).toEqual(INTRINSIC_KEYS);
  });

  it("copies every post-intrinsic column onto the card fields", () => {
    const published = "2026-08-25T00:00:00.000Z";
    const out = postIntrinsics(row({ published_at: published }), ctx());
    expect(out.id).toBe("p1");
    expect(out.title).toBe("Gallop this morning");
    expect(out.body).toBe("Went well.");
    expect(out.label).toBe("Trackwork");
    expect(out.watermarked).toBe(true);
    expect(out.count).toBe(7);
    expect(out.media.type).toBe("photo");
    expect(out.postedAgo).toBe(relativeTime(published));
  });

  // ENG-775's bug, now structurally impossible: the saved screen dropped `label`
  // in its own mapper even though the star projection had it on the row.
  it("carries a null label through rather than dropping the key", () => {
    const out = postIntrinsics(row({ label: null }), ctx());
    expect(out.label).toBeNull();
    expect(Object.keys(out)).toContain("label");
  });

  it("signs the poster from poster_url, falling back to media_url", () => {
    const signed = new Map([["poster.jpg", "https://signed/poster"]]);
    const out = postIntrinsics(row({ poster_url: "poster.jpg" }), ctx({ signedMedia: signed }));
    expect(out.media.posterUrl).toBe("https://signed/poster");

    const viaMedia = postIntrinsics(row(), ctx());
    expect(viaMedia.media.posterUrl).toBe("https://signed/p1");
  });

  it("yields a null poster when nothing signed, rather than a raw path", () => {
    const out = postIntrinsics(row(), ctx({ signedMedia: new Map() }));
    expect(out.media.posterUrl).toBeNull();
  });

  // The `typeof` guard is load-bearing, not belt-and-braces: `'NaN'::numeric`
  // passes the be's `CHECK (aspect_ratio > 0)` and `to_json` serialises it as the
  // QUOTED string "NaN", which would otherwise widen a string into a `number`.
  it("passes aspect_ratio through RAW, but rejects a non-number", () => {
    expect(postIntrinsics(row({ aspect_ratio: 0.5625 }), ctx()).media.aspectRatio).toBe(0.5625);
    expect(postIntrinsics(row({ aspect_ratio: null }), ctx()).media.aspectRatio).toBeNull();

    const nan = row({ aspect_ratio: "NaN" as unknown as number });
    expect(postIntrinsics(nan, ctx()).media.aspectRatio).toBeNull();
  });

  it("defaults photos to an empty array and reacted to null", () => {
    const out = postIntrinsics(row(), ctx());
    expect(out.photos).toEqual([]);
    expect(out.reacted).toBeNull();
  });

  it("reads photos and the viewer's own reaction from the batched maps", () => {
    const photos: PostPhoto[] = [{ url: "https://signed/a", sort: 0 }];
    const out = postIntrinsics(
      row(),
      ctx({
        photosByPost: new Map([["p1", photos]]),
        reactionByPost: new Map<string, ReactionEmoji>([["p1", "clap"]]),
      }),
    );
    expect(out.photos).toEqual(photos);
    expect(out.reacted).toBe("clap");
  });

  it("does not mutate the row it was given", () => {
    const r = row();
    const before = JSON.stringify(r);
    postIntrinsics(r, ctx());
    expect(JSON.stringify(r)).toBe(before);
  });
});

describe("relativeTime", () => {
  // Was defined three times independently (explore-feed, following-screen,
  // saved-feed), all byte-identical. These pin the behaviour the three copies
  // shared, so consolidating them cannot have changed any byline.
  it("renders the buckets the cards have always shown", () => {
    const at = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(relativeTime(null)).toBe("");
    expect(relativeTime(at(10 * 1000))).toBe("just now");
    expect(relativeTime(at(5 * 60 * 1000))).toBe("5m ago");
    expect(relativeTime(at(3 * 60 * 60 * 1000))).toBe("3h ago");
    expect(relativeTime(at(2 * 24 * 60 * 60 * 1000))).toBe("2d ago");
  });

  it("clamps a future timestamp to just now rather than going negative", () => {
    expect(relativeTime(new Date(Date.now() + 60_000).toISOString())).toBe("just now");
  });
});
