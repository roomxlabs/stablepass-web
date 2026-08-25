// ENG-762 — the multi-photo carousel, on the card and through the real card
// component (not just the carousel in isolation), because what the ticket is
// about is the CARD gaining dots and a count.
//
// ENG-815 repoints the carousel's source of slides from a client-resolved
// `PostPhoto[]` (ENG-762) onto the batch mint's `slideCount` plus per-index
// mints through `/api/posts/media` (ENG-809 decision 2). `global.fetch` is
// therefore stubbed in every test that mounts a 2+ slide carousel — the
// component mints slide 1 (the "prefetch one ahead" of ENG-809 decision 1) as
// soon as it mounts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhotoCarousel, MediaPhotoChip } from "@/components/photo-carousel";
import { PostCard, isCarouselPost } from "@/components/post-card";
import type { FeedPost } from "@/components/types";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";
const noop = () => {};

function photoPost(overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    id: "post-1",
    horseId: "horse-1",
    horseName: "Winx",
    trainerName: "Chris Waller",
    postedAgo: "1d ago",
    label: null,
    body: "Recovery day in the paddock.",
    media: { type: "photo", posterUrl: "https://signed/photo-0" },
    watermarked: false,
    raceBadge: null,
    count: 12,
    reacted: null,
    bookmarked: false,
    ...overrides,
  };
}

function card(post: FeedPost) {
  return render(<PostCard post={post} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);
}

// The default mint stub: `{ postId, slideIndex }` → that same slide's url,
// named the same way the pre-ENG-815 fixtures were ("photo-<index>"), so the
// assertions below that pin exact urls read the same as they always did.
function stubMintFetch() {
  global.fetch = vi.fn((_input: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          postId: body.postId,
          slideIndex: body.slideIndex,
          mediaUrl: `https://signed/photo-${body.slideIndex}`,
          expiresAt: "2026-08-01T00:00:00.000Z",
        },
      }),
    });
  }) as unknown as typeof fetch;
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
  stubMintFetch();
});
afterEach(() => cleanup());

describe("isCarouselPost — what makes a post a carousel", () => {
  it("is false for a legacy photo post with no slideCount", () => {
    expect(isCarouselPost(photoPost())).toBe(false);
  });

  it("is false for a ONE-photo post — slideCount 1 and no slideCount at all are the same case", () => {
    // post.media_url mirrors slide 0, so a one-slide post is indistinguishable
    // from a legacy one by contract. No dots, no pager.
    expect(isCarouselPost(photoPost({ slideCount: 1 }))).toBe(false);
  });

  it("is true for a 2+ photo post", () => {
    expect(isCarouselPost(photoPost({ slideCount: 3 }))).toBe(true);
  });

  it("is false for a VIDEO post even with a slideCount", () => {
    // v1 is photo-only: video stays a single Mux asset and never carries slides.
    const post = photoPost({ media: { type: "video", posterUrl: null, duration: "0:47" }, slideCount: 3 });
    expect(isCarouselPost(post)).toBe(false);
  });

  it("is false for a text/update post", () => {
    const post = photoPost({ media: { type: "text", posterUrl: null }, slideCount: 3 });
    expect(isCarouselPost(post)).toBe(false);
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
  it("renders one slide per photo inside the existing media box", async () => {
    const { container } = card(photoPost({ slideCount: 3 }));
    await screen.findByTestId("photo-track");
    expect(screen.getAllByTestId("photo-slide")).toHaveLength(3);
    // Still ONE media box: the carousel fills it rather than adding its own.
    expect(container.querySelectorAll(".post-media-web")).toHaveLength(1);
  });

  it("mints slide 1 on mount and slide 2 only once navigated to (prefetch one ahead, ENG-809 decision 1)", async () => {
    const user = userEvent.setup();
    card(photoPost({ slideCount: 3 }));
    await screen.findByTestId("photo-track");

    // Slide 0 is the batch's own url; slide 1 is prefetched on mount; slide 2
    // has not been asked for yet, so it draws the same blank ground a refused
    // slide would — "not yet" and "never" are deliberately indistinguishable.
    await waitFor(() => {
      const srcs = screen.getAllByTestId("photo-slide").map((s) => s.querySelector("img")?.getAttribute("src"));
      expect(srcs).toEqual(["https://signed/photo-0", "https://signed/photo-1", undefined]);
    });

    await user.click(within(screen.getByTestId("photo-dots")).getAllByRole("button")[2]);

    await waitFor(() => {
      const srcs = screen.getAllByTestId("photo-slide").map((s) => s.querySelector("img")?.getAttribute("src"));
      expect(srcs).toEqual(["https://signed/photo-0", "https://signed/photo-1", "https://signed/photo-2"]);
    });
  });

  it("renders one dot per photo", async () => {
    card(photoPost({ slideCount: 3 }));
    await screen.findByTestId("photo-dots");
    expect(within(screen.getByTestId("photo-dots")).getAllByRole("button")).toHaveLength(3);
  });

  it("EXTENDS the photo chip with an n/m count rather than adding a second chip", async () => {
    // The ENG-761 affordance grows a count; it is not duplicated.
    card(photoPost({ slideCount: 3 }));
    await screen.findByTestId("photo-dots");
    expect(screen.getAllByTestId("media-photo-chip")).toHaveLength(1);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/3");
    expect(screen.getByTestId("media-photo-chip")).toHaveAttribute("aria-label", "Photo 1 of 3");
  });

  it("marks the first dot active on mount", async () => {
    card(photoPost({ slideCount: 3 }));
    await screen.findByTestId("photo-dots");
    const dots = within(screen.getByTestId("photo-dots")).getAllByRole("button");
    expect(dots[0]).toHaveAttribute("aria-current", "true");
    expect(dots[1]).toHaveAttribute("aria-current", "false");
  });

  it("keeps the media box's aspect ratio — the carousel does not resize the card", async () => {
    const { container } = card(photoPost({ slideCount: 3, media: { type: "photo", posterUrl: null, aspectRatio: 1 } }));
    await screen.findByTestId("photo-track");
    const box = container.querySelector(".post-media-web") as HTMLElement;
    // jsdom normalises the shorthand, so `"1"` reads back as `"1 / 1"`.
    expect(box.style.aspectRatio.replace(/\s/g, "")).toBe("1/1");
  });
});

describe("PhotoCarousel — paging by the dots", () => {
  it("scrolls the track and moves the count when a dot is pressed", async () => {
    const user = userEvent.setup();
    card(photoPost({ slideCount: 3 }));
    await screen.findByTestId("photo-dots");
    const dots = within(screen.getByTestId("photo-dots")).getAllByRole("button");

    await user.click(dots[2]);

    expect(scrollToSpy).toHaveBeenCalledWith({ left: 720, behavior: "smooth" });
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("3/3");
    expect(dots[2]).toHaveAttribute("aria-current", "true");
    expect(dots[0]).toHaveAttribute("aria-current", "false");
  });

  it("tracks the middle photo too", async () => {
    const user = userEvent.setup();
    card(photoPost({ slideCount: 3 }));
    await screen.findByTestId("photo-dots");
    const dots = within(screen.getByTestId("photo-dots")).getAllByRole("button");
    await user.click(dots[1]);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("2/3");
    expect(scrollToSpy).toHaveBeenCalledWith({ left: 360, behavior: "smooth" });
  });

  it("updates the count when the track is scrolled by gesture", async () => {
    render(<PhotoCarousel postId="post-1" slideCount={3} firstUrl="https://signed/photo-0" />);
    const track = await screen.findByTestId("photo-track");
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
  it("draws a placeholder for a slide that fails to mint and still renders the others", async () => {
    // Slide 1's mint is refused (a draft, a gap in sort_order, a lapsed
    // subscription — all indistinguishable here by design); slide 0 came in on
    // the batch already and must still render.
    global.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;

    render(<PhotoCarousel postId="post-1" slideCount={2} firstUrl="https://signed/photo-0" />);
    await screen.findByTestId("photo-track");

    await waitFor(() => {
      expect(screen.getAllByTestId("photo-slide")).toHaveLength(2);
      expect(screen.getAllByTestId("photo-slide-empty")).toHaveLength(1);
    });
    // The one good slide still has its image — one dead mint must never take
    // the whole post down.
    expect(screen.getByTestId("photo-track").querySelectorAll("img")).toHaveLength(1);
  });

  it("fits the contract's cap of 10 photos", async () => {
    render(<PhotoCarousel postId="post-1" slideCount={10} firstUrl="https://signed/photo-0" />);
    await screen.findByTestId("photo-dots");
    expect(within(screen.getByTestId("photo-dots")).getAllByRole("button")).toHaveLength(10);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/10");
  });

  // ENG-762's "non-contiguous sort_order" case (a raw `PostPhoto[]` with gaps
  // like `{0, 3, 7}`) no longer has a component-level equivalent: `sort_order`
  // is now a be-only concern, and this component only ever sees `slideCount`
  // (the be's highest-ordinal-plus-one) plus per-index mints. The gap itself —
  // an index that mints to nothing and draws blank rather than dropping a
  // photo — is the "draws a placeholder for a slide that fails to mint" case
  // above; there is nothing left at THIS layer to assert about non-contiguity.
});

describe("PhotoCarousel — accessibility", () => {
  it("gives the track a name and makes it keyboard-reachable", async () => {
    render(<PhotoCarousel postId="post-1" slideCount={3} firstUrl="https://signed/photo-0" />);
    const track = await screen.findByTestId("photo-track");
    expect(track).toHaveAttribute("tabindex", "0");
    expect(track).toHaveAttribute("aria-label", "3 photos");
    expect(track).toHaveAttribute("aria-roledescription", "carousel");
  });

  it("names every dot by its destination", async () => {
    render(<PhotoCarousel postId="post-1" slideCount={3} firstUrl="https://signed/photo-0" />);
    await screen.findByTestId("photo-dots");
    expect(screen.getByRole("button", { name: "Go to photo 2 of 3" })).toBeInTheDocument();
  });

  it("announces the position through the chip, not a bare 'Photo'", async () => {
    render(<PhotoCarousel postId="post-1" slideCount={4} firstUrl="https://signed/photo-0" />);
    await screen.findByTestId("photo-dots");
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
