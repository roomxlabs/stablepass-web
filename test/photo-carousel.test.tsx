// ENG-762 — the multi-photo carousel, on the card and through the real card
// component (not just the carousel in isolation), because what the ticket is
// about is the CARD gaining dots and a count.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhotoCarousel, MediaPhotoChip } from "@/components/photo-carousel";
import { PostCard, carouselPhotos } from "@/components/post-card";
import type { FeedPost, PostPhoto } from "@/components/types";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";
const noop = () => {};

function photos(n: number): PostPhoto[] {
  return Array.from({ length: n }, (_, i) => ({ url: `https://signed/photo-${i}`, sort: i }));
}

function photoPost(overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    id: "post-1",
    horseId: "horse-1",
    horseName: "Winx",
    trainerName: "Chris Waller",
    postedAgo: "1d ago",
    body: "Recovery day in the paddock.",
    media: { type: "photo", posterUrl: "https://signed/photo-0" },
    watermarked: false,
    raceBadge: null,
    count: 12,
    reacted: null,
    bookmarked: false,
    ...overrides,
    // `Partial<FeedPost>` widens every spread field to `| undefined`, and `label`
    // is now REQUIRED on FeedPost (ENG-785), so it must be narrowed back after
    // the spread rather than merely defaulted before it.
    label: overrides.label ?? null,
  };
}

function card(post: FeedPost) {
  return render(<PostCard post={post} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);
}

// jsdom has no layout and no `scrollTo`, so the element gets a stub and a real
// `clientWidth`. Paging by GESTURE is a browser behaviour (CSS scroll-snap) and
// is covered by Playwright; what jsdom can prove is the dot-driven path and the
// state that follows from it — the same split mobile's R16 makes.
let scrollToSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  scrollToSpy = vi.fn();
  Object.defineProperty(Element.prototype, "scrollTo", {
    value: scrollToSpy,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    value: 360,
    writable: true,
    configurable: true,
  });
});
afterEach(() => cleanup());

describe("carouselPhotos — what makes a post a carousel", () => {
  it("is empty for a legacy photo post with no rows", () => {
    expect(carouselPhotos(photoPost())).toEqual([]);
  });

  it("is empty for a ONE-photo post — 0 rows and 1 photo are the same case", () => {
    // post.media_url mirrors sort_order 0, so a single-row post is
    // indistinguishable from a legacy one by contract. No dots, no pager.
    expect(carouselPhotos(photoPost({ photos: photos(1) }))).toEqual([]);
  });

  it("is the photo list for a 2+ photo post", () => {
    expect(carouselPhotos(photoPost({ photos: photos(3) }))).toHaveLength(3);
  });

  it("is empty for a VIDEO post even if rows somehow exist", () => {
    // v1 is photo-only: video stays a single Mux asset and never gets rows.
    const post = photoPost({ media: { type: "video", posterUrl: null, duration: "0:47" }, photos: photos(3) });
    expect(carouselPhotos(post)).toEqual([]);
  });

  it("is empty for a text/update post", () => {
    const post = photoPost({ media: { type: "text", posterUrl: null }, photos: photos(3) });
    expect(carouselPhotos(post)).toEqual([]);
  });
});

describe("PostCard — the single-photo card is unchanged", () => {
  it("draws the plain photo chip and NO dots", () => {
    card(photoPost());
    expect(screen.getByTestId("media-photo-chip")).toHaveAttribute("aria-label", "Photo");
    expect(screen.queryByTestId("photo-dots")).toBeNull();
    expect(screen.queryByTestId("photo-track")).toBeNull();
    expect(screen.queryByTestId("media-photo-count")).toBeNull();
  });

  it("still renders the single poster image, not a track", () => {
    const { container } = card(photoPost());
    const imgs = container.querySelectorAll(".post-media-web img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toHaveAttribute("src", "https://signed/photo-0");
  });
});

describe("PostCard — a multi-photo post becomes a carousel", () => {
  it("renders one slide per photo inside the existing media box", () => {
    const { container } = card(photoPost({ photos: photos(3) }));
    expect(screen.getAllByTestId("photo-slide")).toHaveLength(3);
    // Still ONE media box: the carousel fills it rather than adding its own.
    expect(container.querySelectorAll(".post-media-web")).toHaveLength(1);
  });

  it("renders the slides in sort_order with their signed urls", () => {
    card(photoPost({ photos: photos(3) }));
    const srcs = screen.getAllByTestId("photo-slide").map((s) => s.querySelector("img")?.getAttribute("src"));
    expect(srcs).toEqual(["https://signed/photo-0", "https://signed/photo-1", "https://signed/photo-2"]);
  });

  it("renders one dot per photo", () => {
    card(photoPost({ photos: photos(3) }));
    expect(within(screen.getByTestId("photo-dots")).getAllByRole("button")).toHaveLength(3);
  });

  it("EXTENDS the photo chip with an n/m count rather than adding a second chip", () => {
    // The ENG-761 affordance grows a count; it is not duplicated.
    card(photoPost({ photos: photos(3) }));
    expect(screen.getAllByTestId("media-photo-chip")).toHaveLength(1);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/3");
    expect(screen.getByTestId("media-photo-chip")).toHaveAttribute("aria-label", "Photo 1 of 3");
  });

  it("marks the first dot active on mount", () => {
    card(photoPost({ photos: photos(3) }));
    const dots = within(screen.getByTestId("photo-dots")).getAllByRole("button");
    expect(dots[0]).toHaveAttribute("aria-current", "true");
    expect(dots[1]).toHaveAttribute("aria-current", "false");
  });

  it("keeps the media box's aspect ratio — the carousel does not resize the card", () => {
    const { container } = card(photoPost({ photos: photos(3), media: { type: "photo", posterUrl: null, aspectRatio: 1 } }));
    const box = container.querySelector(".post-media-web") as HTMLElement;
    // jsdom normalises the shorthand, so `"1"` reads back as `"1 / 1"`.
    expect(box.style.aspectRatio.replace(/\s/g, "")).toBe("1/1");
  });
});

describe("PhotoCarousel — paging by the dots", () => {
  it("scrolls the track and moves the count when a dot is pressed", async () => {
    const user = userEvent.setup();
    card(photoPost({ photos: photos(3) }));
    const dots = within(screen.getByTestId("photo-dots")).getAllByRole("button");

    await user.click(dots[2]);

    expect(scrollToSpy).toHaveBeenCalledWith({ left: 720, behavior: "smooth" });
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("3/3");
    expect(dots[2]).toHaveAttribute("aria-current", "true");
    expect(dots[0]).toHaveAttribute("aria-current", "false");
  });

  it("tracks the middle photo too", async () => {
    const user = userEvent.setup();
    card(photoPost({ photos: photos(3) }));
    const dots = within(screen.getByTestId("photo-dots")).getAllByRole("button");
    await user.click(dots[1]);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("2/3");
    expect(scrollToSpy).toHaveBeenCalledWith({ left: 360, behavior: "smooth" });
  });

  it("updates the count when the track is scrolled by gesture", () => {
    render(<PhotoCarousel photos={photos(3)} />);
    const track = screen.getByTestId("photo-track");
    // Two slides across at 360px each. This is the closest jsdom gets to a
    // swipe: it has no layout and never fires a real scroll, so the position is
    // set directly and the handler driven from it. Real gesture paging is CSS
    // scroll-snap and is evidenced in Playwright.
    Object.defineProperty(track, "scrollLeft", { value: 720, writable: true, configurable: true });
    act(() => {
      fireEvent.scroll(track);
    });
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("3/3");
  });
});

describe("PhotoCarousel — states the ticket names", () => {
  it("draws a placeholder for a photo that failed to sign and still renders the others", () => {
    const list: PostPhoto[] = [
      { url: "https://signed/a", sort: 0 },
      { url: null, sort: 1 },
      { url: "https://signed/c", sort: 2 },
    ];
    render(<PhotoCarousel photos={list} />);
    expect(screen.getAllByTestId("photo-slide")).toHaveLength(3);
    expect(screen.getAllByTestId("photo-slide-empty")).toHaveLength(1);
    // The two good slides still have their images — one dead object must never
    // take the whole post down.
    expect(screen.getByTestId("photo-track").querySelectorAll("img")).toHaveLength(2);
  });

  it("fits the contract's cap of 10 photos", () => {
    render(<PhotoCarousel photos={photos(10)} />);
    expect(within(screen.getByTestId("photo-dots")).getAllByRole("button")).toHaveLength(10);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/10");
  });

  it("carries non-contiguous sort values without inferring position from the index", () => {
    const list: PostPhoto[] = [
      { url: "https://signed/a", sort: 0 },
      { url: "https://signed/b", sort: 3 },
      { url: "https://signed/c", sort: 7 },
    ];
    render(<PhotoCarousel photos={list} />);
    // The COUNT is 1..n over what exists, never the raw sort_order — a post
    // showing "1/7" because the last row is sort 7 would be wrong.
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/3");
  });
});

describe("PhotoCarousel — accessibility", () => {
  it("gives the track a name and makes it keyboard-reachable", () => {
    render(<PhotoCarousel photos={photos(3)} />);
    const track = screen.getByTestId("photo-track");
    expect(track).toHaveAttribute("tabindex", "0");
    expect(track).toHaveAttribute("aria-label", "3 photos");
    expect(track).toHaveAttribute("aria-roledescription", "carousel");
  });

  it("names every dot by its destination", () => {
    render(<PhotoCarousel photos={photos(3)} />);
    expect(screen.getByRole("button", { name: "Go to photo 2 of 3" })).toBeInTheDocument();
  });

  it("announces the position through the chip, not a bare 'Photo'", () => {
    render(<PhotoCarousel photos={photos(4)} />);
    expect(screen.getByTestId("media-photo-chip")).toHaveAttribute("aria-label", "Photo 1 of 4");
  });
});

describe("MediaPhotoChip — one affordance, two states", () => {
  it("is the plain glyph chip by default (the ENG-761 behaviour, unchanged)", () => {
    render(<MediaPhotoChip />);
    const chip = screen.getByTestId("media-photo-chip");
    expect(chip).toHaveAttribute("aria-label", "Photo");
    expect(chip.className).toBe("media-photo-chip");
    expect(screen.queryByTestId("media-photo-count")).toBeNull();
  });

  it("takes the counted modifier and the n/m text when there is more than one", () => {
    render(<MediaPhotoChip index={1} total={3} />);
    const chip = screen.getByTestId("media-photo-chip");
    expect(chip.className).toBe("media-photo-chip counted");
    expect(within(chip).getByTestId("media-photo-count")).toHaveTextContent("2/3");
  });
});
