import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PostCard } from "@/components/post-card";
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
