import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { PostMediaImage, MediaLoadPriority } from "@/components/post-media-image";

// ENG-1593 — `MediaLoadPriority` is how a SCREEN marks its first card's image
// as the page's largest paint (eager, high fetchPriority) while every other
// card stays exactly as it always was (no hint at all) unless the screen opts
// it into "lazy". These pin the element's own branching in isolation from any
// screen; test/explore-feed.test.tsx pins the screen's wiring of it.
beforeEach(() => {
  vi.restoreAllMocks();
});

describe("PostMediaImage — ENG-1593 MediaLoadPriority", () => {
  it("no provider (the default): renders an <img> with NEITHER loading NOR fetchpriority", () => {
    const { container } = render(<PostMediaImage postId="p1" src="https://cdn/x.jpg" />);
    const img = container.querySelector("img")!;
    expect(img).toBeInTheDocument();
    expect(img).not.toHaveAttribute("loading");
    expect(img).not.toHaveAttribute("fetchpriority");
  });

  it('"high" at slide 0 (the default slideIndex): eager + fetchpriority="high"', () => {
    const { container } = render(
      <MediaLoadPriority.Provider value="high">
        <PostMediaImage postId="p1" src="https://cdn/x.jpg" />
      </MediaLoadPriority.Provider>,
    );
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("loading", "eager");
    expect(img).toHaveAttribute("fetchpriority", "high");
  });

  it('"high" at slideIndex 1: lazy, not high — only slide 0 is ever the page\'s largest paint', () => {
    const { container } = render(
      <MediaLoadPriority.Provider value="high">
        <PostMediaImage postId="p1" src="https://cdn/x.jpg" slideIndex={1} />
      </MediaLoadPriority.Provider>,
    );
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).not.toHaveAttribute("fetchpriority");
  });

  it('"lazy": loading="lazy" and no fetchpriority', () => {
    const { container } = render(
      <MediaLoadPriority.Provider value="lazy">
        <PostMediaImage postId="p1" src="https://cdn/x.jpg" />
      </MediaLoadPriority.Provider>,
    );
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).not.toHaveAttribute("fetchpriority");
  });
});
