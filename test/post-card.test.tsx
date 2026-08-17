import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  PostCard,
  resolveAspect,
  aspectBucket,
  mediaBoxProps,
  ASPECT_MIN,
  ASPECT_MAX,
  ASPECT_DEFAULT,
} from "@/components/post-card";
import type { FeedPost } from "@/components/types";

const BASE: FeedPost = {
  id: "post-1",
  horseId: "horse-1",
  horseName: "Mahogany",
  trainerName: "Chris Waller",
  postedAgo: "2h ago",
  body: "Trackwork this morning.",
  media: { type: "photo", posterUrl: null },
  watermarked: false,
  raceBadge: null,
  count: 12,
  reacted: null,
  bookmarked: false,
};

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

const noop = () => {};

describe("PostCard", () => {
  it("shows the watermark overlay (brand mark + viewer-id tag) when watermarked", () => {
    render(
      <PostCard
        post={{ ...BASE, watermarked: true }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    const overlay = screen.getByTestId("post-overlay");
    expect(overlay).toBeInTheDocument();
    expect(overlay).toHaveTextContent("stablepass.");
    expect(screen.getByText(/^SP·[0-9A-F]+$/)).toBeInTheDocument();
  });

  it("renders no overlay when not watermarked", () => {
    render(
      <PostCard
        post={{ ...BASE, watermarked: false }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    expect(screen.queryByTestId("post-overlay")).not.toBeInTheDocument();
  });

  it("shows a Play video button for a video post", () => {
    render(
      <PostCard
        post={{ ...BASE, media: { type: "video", posterUrl: null, duration: "0:47" } }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
        onPlay={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Play video" })).toBeInTheDocument();
  });

  it("shows no Play video button for a photo post", () => {
    render(
      <PostCard
        post={{ ...BASE, media: { type: "photo", posterUrl: null } }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    expect(screen.queryByRole("button", { name: "Play video" })).not.toBeInTheDocument();
  });
});

// ENG-612 — the media box reads `post.aspect_ratio` instead of a hardcoded
// bucket. The clamp numbers are restated in full in post-card.tsx rather than
// imported from a shared package (mobile/admin/web are separate codebases), so
// these tests are what stop the three drifting apart.
describe("resolveAspect", () => {
  it("passes a real 16:9 through unchanged", () => {
    expect(resolveAspect(1.7778)).toBe(1.7778);
  });

  it("passes a real 1:1 through unchanged", () => {
    expect(resolveAspect(1)).toBe(1);
  });

  it("clamps a 9:16 reel up to the 4:5 floor rather than letterboxing it", () => {
    expect(resolveAspect(0.5625)).toBe(ASPECT_MIN);
    expect(ASPECT_MIN).toBe(0.8);
  });

  it("clamps an ultra-wide down to the 1.91:1 ceiling", () => {
    expect(resolveAspect(2.4)).toBe(ASPECT_MAX);
    expect(ASPECT_MAX).toBe(1.91);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["zero", 0],
    ["negative", -1],
  ])("falls back to 16:10 for %s", (_label, value) => {
    expect(resolveAspect(value as number | null | undefined)).toBe(ASPECT_DEFAULT);
    expect(ASPECT_DEFAULT).toBe(1.6);
  });

  // `'NaN'::numeric` is legal in Postgres AND passes the be's
  // `CHECK (aspect_ratio > 0)`, so the column constraint does not protect us.
  it("falls back to 16:10 for NaN — the column's own CHECK does not catch it", () => {
    expect(resolveAspect(Number.NaN)).toBe(ASPECT_DEFAULT);
  });

  it("falls back to 16:10 for Infinity", () => {
    expect(resolveAspect(Number.POSITIVE_INFINITY)).toBe(ASPECT_DEFAULT);
  });

  // `sb` is untyped, so a string can reach this at runtime even though the
  // signature says `number`. `Number.isFinite` does not coerce, unlike the
  // global `isFinite`, which is exactly why it is the guard we use.
  it("falls back to 16:10 for a non-number that slipped past the untyped client", () => {
    expect(resolveAspect("1.5" as unknown as number)).toBe(ASPECT_DEFAULT);
  });
});

describe("aspectBucket — the CSS fallback class", () => {
  it("buckets a clamped reel as tall", () => {
    expect(aspectBucket(ASPECT_MIN)).toBe("tall");
  });

  it("buckets a square asset as square", () => {
    expect(aspectBucket(1)).toBe("square");
  });

  it("buckets 16:9 and the 16:10 default as wide", () => {
    expect(aspectBucket(1.7778)).toBe("wide");
    expect(aspectBucket(ASPECT_DEFAULT)).toBe("wide");
  });

  it("gives wide no modifier class, since the stylesheet's base rule IS wide", () => {
    expect(mediaBoxProps(1.7778).className).toBe("post-media-web");
    expect(mediaBoxProps(0.5625).className).toBe("post-media-web tall");
    expect(mediaBoxProps(1).className).toBe("post-media-web square");
  });
});

describe("PostCard media geometry", () => {
  const boxOf = (container: HTMLElement) =>
    container.querySelector<HTMLElement>(".post-media-web");

  // Assert the GEOMETRY, not the serialisation: `aspect-ratio: 1.6` is
  // normalised to the equivalent `1.6 / 1` by jsdom (and by browsers' computed
  // style), so comparing the raw string would pin a serialiser quirk instead of
  // the shape of the box.
  const ratioOf = (el: HTMLElement): number => {
    const [w, h = "1"] = el.style.aspectRatio.split("/").map((part) => part.trim());
    return Number(w) / Number(h);
  };

  const renderWith = (aspectRatio: number | null) =>
    render(
      <PostCard
        post={{ ...BASE, media: { type: "photo", posterUrl: null, aspectRatio } }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

  it("puts the resolved ratio on the media box as an inline aspect-ratio", () => {
    const { container } = renderWith(1.7778);
    const box = boxOf(container);
    expect(box).not.toBeNull();
    expect(ratioOf(box!)).toBeCloseTo(1.7778, 4);
  });

  it("crops a reel to the 4:5 floor and tags the box tall", () => {
    const { container } = renderWith(0.5625);
    const box = boxOf(container)!;
    expect(ratioOf(box)).toBeCloseTo(0.8, 4);
    expect(box.className).toBe("post-media-web tall");
  });

  it("renders a square asset 1:1", () => {
    const { container } = renderWith(1);
    const box = boxOf(container)!;
    expect(ratioOf(box)).toBeCloseTo(1, 4);
    expect(box.className).toBe("post-media-web square");
  });

  it("caps an ultra-wide at 1.91:1", () => {
    const { container } = renderWith(2.4);
    expect(ratioOf(boxOf(container)!)).toBeCloseTo(1.91, 4);
  });

  // The common case: every photo and every pre-backfill video.
  it("falls back to 16:10 with an unknown ratio, and still has a real box", () => {
    const { container } = renderWith(null);
    const box = boxOf(container)!;
    expect(ratioOf(box)).toBeCloseTo(1.6, 4);
    // The bucket class is the CSS fallback that guarantees the box is never
    // zero-height before the inline value applies. `wide` is the base rule, so
    // the class list is the bare one — never an unknown modifier.
    expect(box.className).toBe("post-media-web");
  });

  it("still draws a media box when the media type is video", () => {
    const { container } = render(
      <PostCard
        post={{ ...BASE, media: { type: "video", posterUrl: null, duration: "0:47", aspectRatio: 0.5625 } }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
        onPlay={vi.fn()}
      />,
    );
    expect(ratioOf(boxOf(container)!)).toBeCloseTo(0.8, 4);
  });

  // A text/voice post renders no media box at all — unchanged by this ticket,
  // and pinned so the geometry work cannot accidentally introduce one.
  it("renders no media box for a text post", () => {
    const { container } = render(
      <PostCard
        post={{ ...BASE, media: { type: "text", posterUrl: null } }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );
    expect(boxOf(container)).toBeNull();
  });
});
