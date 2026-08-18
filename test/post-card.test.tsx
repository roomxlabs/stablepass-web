import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

// ===========================================================================
// ENG-613 (W2) — member card parity with mobile, rows 3 to 6.
// Row 3 (the name's font and colour) is a stylesheet fact and lives in
// test/post-card-parity.test.ts; jsdom would assert it vacuously here.
// ===========================================================================

/** Tree order within the card, which is what "below the reaction bar" means. */
function cardChildren(): Element[] {
  const article = document.querySelector("article.post-web");
  expect(article, "no .post-web article rendered").not.toBeNull();
  return Array.from(article!.children);
}

function indexOfClass(cls: string): number {
  return cardChildren().findIndex((el) => el.classList.contains(cls));
}

const TEXT_POST: FeedPost = {
  ...BASE,
  media: { type: "text", posterUrl: null },
  title: "Where the team is up to",
  body: "Quiet week here.\n\nBanjo's Girl trials Tuesday.",
  stableName: "Tom Alcott Racing",
  stableLocation: "Sydney",
  trainerName: "Tom Alcott",
};

describe("PostCard — row 4, the caption sits below the reaction bar", () => {
  // Asserting TREE ORDER, not merely that both nodes exist: presence alone
  // passed perfectly well before this ticket, when the caption was above.
  it("renders the caption after the reaction bar in DOM order", () => {
    render(<PostCard post={BASE} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    const actions = indexOfClass("post-actions-web");
    const body = indexOfClass("post-body-web");

    expect(actions).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThan(actions);
  });

  it("still renders the reaction bar when there is no caption at all", () => {
    render(<PostCard post={{ ...BASE, body: null }} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    expect(indexOfClass("post-actions-web")).toBeGreaterThanOrEqual(0);
    expect(indexOfClass("post-body-web")).toBe(-1);
  });
});

describe("PostCard — row 5, the Follow pill", () => {
  it("offers the pill on the media when the screen says the trainer is unfollowed", () => {
    render(<PostCard post={BASE} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} canFollow />);

    const pill = screen.getByRole("button", { name: "Follow Chris Waller" });
    expect(pill).toBeInTheDocument();
    // Top-right of the MEDIA, not of the card: the stylesheet positions it
    // against `.post-media-web`, so being outside that box would silently
    // reposition it to the card corner.
    expect(pill.closest(".post-media-web")).not.toBeNull();
  });

  it("shows no pill when the viewer already follows the trainer", () => {
    render(<PostCard post={BASE} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} canFollow={false} />);

    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
  });

  // The default is what suppresses the pill on a trainer's own profile feed and
  // on every other surface that holds no follow state: those screens simply do
  // not pass the prop, so the suppression is structural rather than a flag they
  // must remember to set.
  it("shows no pill by default, which is how the trainer profile suppresses it", () => {
    render(<PostCard post={BASE} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
  });

  it("passes the click up to the screen, which owns the write", async () => {
    const onFollow = vi.fn();
    render(<PostCard post={BASE} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} canFollow onFollow={onFollow} />);

    await userEvent.click(screen.getByRole("button", { name: "Follow Chris Waller" }));
    expect(onFollow).toHaveBeenCalledTimes(1);
  });

  // A text post has no media box for the pill to sit in.
  it("shows no pill on a post with no media, even when unfollowed", () => {
    render(<PostCard post={TEXT_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} canFollow />);

    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
  });
});

describe("PostCard — row 6, the STABLE UPDATE card", () => {
  it("gives a text post the pill, the title, the panel and the byline", () => {
    render(<PostCard post={TEXT_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    expect(screen.getByText("Stable update")).toHaveClass("post-badge");
    expect(screen.getByText("Where the team is up to")).toHaveClass("post-title");
    expect(document.querySelector(".post-panel")).not.toBeNull();
    // No media box: the panel stands in its place.
    expect(document.querySelector(".post-media-web")).toBeNull();
  });

  it("renders the reaction bar AFTER the panel", () => {
    render(<PostCard post={TEXT_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    const panel = indexOfClass("post-panel");
    const actions = indexOfClass("post-actions-web");
    expect(panel).toBeGreaterThanOrEqual(0);
    expect(actions).toBeGreaterThan(panel);
  });

  // The horse stays in the byline for the same reason as mobile's M4:
  // `post.horse_id` is NOT NULL and trainer → horse → post is the product's
  // spine. The website sample drops the horse; we deliberately do not.
  it("carries BOTH the trainer and the horse in the byline", () => {
    render(<PostCard post={TEXT_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    const byline = document.querySelector(".post-byline");
    expect(byline).not.toBeNull();
    expect(byline!.textContent).toContain("Tom Alcott");
    expect(byline!.textContent).toContain("Mahogany");
    expect(byline!.textContent).toContain("2h ago");
  });

  it("splits the body into a paragraph per blank-line break, with the stable footer", () => {
    render(<PostCard post={TEXT_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    const paras = document.querySelectorAll(".post-panel p");
    expect(paras).toHaveLength(2);
    expect(paras[0].textContent).toBe("Quiet week here.");
    expect(paras[1].textContent).toBe("Banjo's Girl trials Tuesday.");
    expect(document.querySelector(".post-panel-foot")!.textContent).toContain("Tom Alcott Racing · Sydney");
  });

  it("renders whichever half of the stable footer exists", () => {
    render(
      <PostCard
        post={{ ...TEXT_POST, stableName: "Tom Alcott Racing", stableLocation: null }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    const foot = document.querySelector(".post-panel-foot");
    expect(foot!.textContent).toContain("Tom Alcott Racing");
    expect(foot!.textContent).not.toContain("·");
  });

  it("omits the footer entirely when neither half exists", () => {
    render(
      <PostCard
        post={{ ...TEXT_POST, stableName: null, stableLocation: null }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    expect(document.querySelector(".post-panel")).not.toBeNull();
    expect(document.querySelector(".post-panel-foot")).toBeNull();
  });

  // A2 makes body required going forward; this is the defensive case.
  it("renders no panel for a text post with an empty body", () => {
    render(
      <PostCard post={{ ...TEXT_POST, body: null }} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />,
    );

    expect(screen.getByText("Stable update")).toBeInTheDocument();
    expect(document.querySelector(".post-panel")).toBeNull();
  });

  it("still renders pill and panel for a text post with no title", () => {
    render(
      <PostCard post={{ ...TEXT_POST, title: null }} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />,
    );

    expect(screen.getByText("Stable update")).toBeInTheDocument();
    expect(document.querySelector(".post-panel")).not.toBeNull();
    expect(document.querySelector(".post-title")).toBeNull();
  });

  // The pill copy is COPY, not data: nothing in the payload names the card.
  it("labels a news post `News`", () => {
    render(
      <PostCard
        post={{ ...TEXT_POST, media: { type: "news", posterUrl: null } }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    expect(screen.getByText("News")).toHaveClass("post-badge");
    expect(screen.queryByText("Stable update")).not.toBeInTheDocument();
    expect(document.querySelector(".post-panel")).not.toBeNull();
  });

  // Card selection is by `type`, exactly as in mobile's M4 table — a title is
  // not what makes a STABLE UPDATE card.
  it("gives a titled VIDEO post a bare headline, with no pill and no panel", () => {
    render(
      <PostCard
        post={{ ...BASE, media: { type: "video", posterUrl: null, duration: "0:47" }, title: "Gallop day" }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
        onPlay={vi.fn()}
      />,
    );

    expect(screen.getByText("Gallop day")).toHaveClass("post-title");
    expect(document.querySelector(".post-badge")).toBeNull();
    expect(document.querySelector(".post-panel")).toBeNull();
    // The horse keeps its own line on a media card; only the update card
    // trades it for the pill.
    expect(screen.getByText("Mahogany")).toHaveClass("post-horse");
  });
});

describe("PostCard — heading structure", () => {
  // The design source draws exactly one heading per card: the horse on a media
  // card, the title on an update card, never both. A titled photo post used to
  // emit two sibling <h3>s in inverted visual hierarchy.
  it("emits exactly one h3 on a titled media post, and it is the horse", () => {
    render(
      <PostCard
        post={{ ...BASE, media: { type: "photo", posterUrl: null }, title: "Gallop day" }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    const headings = document.querySelectorAll("article.post-web h3");
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveClass("post-horse");
    // The title is still rendered and still styled — just not as a heading.
    expect(screen.getByText("Gallop day")).toHaveClass("post-title");
  });

  it("emits exactly one h3 on an update card, and it is the title", () => {
    render(<PostCard post={TEXT_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    const headings = document.querySelectorAll("article.post-web h3");
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveClass("post-title");
  });

  // Defensive: A2 makes body required going forward, but whitespace is not null.
  it("renders no panel for a whitespace-only body", () => {
    render(
      <PostCard post={{ ...TEXT_POST, body: "   \n\n  \t " }} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />,
    );

    expect(screen.getByText("Stable update")).toBeInTheDocument();
    expect(document.querySelector(".post-panel")).toBeNull();
  });
});
