import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PostCard,
  PostCaption,
  resolveAspect,
  aspectBucket,
  mediaBoxProps,
  ASPECT_MIN,
  ASPECT_MAX,
  ASPECT_DEFAULT,
  panelLineCount,
  panelClampHeight,
  PANEL_CLAMP_LINES,
  PANEL_PARAGRAPH_GAP,
  READ_MORE_LABEL,
  READ_LESS_LABEL,
} from "@/components/post-card";
import type { FeedPost } from "@/components/types";

// ENG-785 — `label` must stay REQUIRED on `FeedPost`. Dropping the `?` is the
// whole point of that ticket: it is what turns a mapper that forgets a column
// into a compile error instead of a pill nobody notices is missing for weeks.
// Nothing stopped a future edit from quietly putting the `?` back, so this line
// is the guard on the guard. `Record<string, never> extends T` holds only when
// every key of T is optional, so `label?:` collapses this to `never` and fails
// the build.
type LabelIsRequired<T> = Record<string, never> extends T ? never : true;
const _labelStaysRequired: LabelIsRequired<Pick<FeedPost, "label">> = true;
void _labelStaysRequired;

const BASE: FeedPost = {
  id: "post-1",
  horseId: "horse-1",
  horseName: "Mahogany",
  trainerName: "Chris Waller",
  postedAgo: "2h ago",
  label: null,
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

  it("still draws a media box when the media type is video — at the REEL ratio since 18 Aug", () => {
    const { container } = render(
      <PostCard
        post={{ ...BASE, media: { type: "video", posterUrl: null, duration: "0:47", aspectRatio: 0.5625 } }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
        onPlay={vi.fn()}
      />,
    );
    // A portrait VIDEO is a reel: the 4:5 clamp is lifted and the true 9:16
    // renders (see "the reel card" below). Photos keep the 0.8 floor.
    expect(ratioOf(boxOf(container)!)).toBeCloseTo(0.5625, 4);
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

describe("no shares CTA (ENG-956)", () => {
  const WEBSITE_POST: FeedPost = {
    ...BASE,
    trainerId: "3f1c9b2e-5a4d-4c8b-9e7a-1d2b3c4d5e6f",
    websiteUrl: "https://example.com",
  };

  it("never renders a Contact-trainer CTA, even when websiteUrl is set", () => {
    const { container } = render(
      <PostCard post={WEBSITE_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />,
    );

    // positive anchor first — prove the card actually rendered before asserting absence.
    expect(screen.getByText("Mahogany")).toBeInTheDocument();

    expect(screen.queryByRole("link", { name: /Contact trainer/i })).not.toBeInTheDocument();
    expect(container.querySelector(".post-contact-cta")).toBeNull();
  });

  it("GUARDRAIL: the shares variant/CTA code path is fully removed from post-card.tsx", () => {
    const raw = fs.readFileSync(path.join(process.cwd(), "components/post-card.tsx"), "utf8");
    // Strip comments first — this file legitimately documents the removal
    // ("ENG-831's `variant=\"shares\"` ... ENG-956 removed it here") and a
    // naive substring check would trip on that prose, not on live code.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const src = code.replace(/\s+/g, " ");
    expect(src).not.toContain('variant="shares"');
    expect(src).not.toContain("Contact trainer");
    expect(src).not.toContain("contactHref");
  });
});

describe("PostCard — row 6, the STABLE UPDATE card", () => {
  // 18 Aug 2026 (Justin): the ".post-badge" pill is retired — the horse-name
  // headline heads this card exactly like every other variant.
  it("gives a text post the horse headline, the title, the panel and the byline", () => {
    render(<PostCard post={TEXT_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    expect(screen.queryByText("Stable update")).not.toBeInTheDocument();
    expect(screen.getByText("Mahogany")).toHaveClass("post-horse");
    // 18 Aug, second amendment: the title is not drawn either.
    expect(screen.queryByText("Where the team is up to")).toBeNull();
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

  // The horse is back in the HEADLINE (pill retired, 18 Aug 2026), so the
  // byline is the trainer line — with NO "by" prefix (18 Aug: "just the
  // trainer name straight away") — and never repeats the horse.
  it("carries the bare trainer name in the byline, with the horse in the headline above", () => {
    render(<PostCard post={TEXT_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    const byline = document.querySelector(".post-byline");
    expect(byline).not.toBeNull();
    expect(byline!.textContent).toContain("Tom Alcott");
    expect(byline!.textContent).not.toMatch(/\bby\b/);
    expect(byline!.textContent).not.toContain("Mahogany");
    expect(byline!.textContent).toContain("2h ago");
    expect(screen.getByText("Mahogany")).toHaveClass("post-horse");
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

    expect(screen.getByText("Mahogany")).toHaveClass("post-horse");
    expect(document.querySelector(".post-panel")).toBeNull();
  });

  it("still renders the panel for a text post with no title", () => {
    render(
      <PostCard post={{ ...TEXT_POST, title: null }} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />,
    );

    expect(document.querySelector(".post-panel")).not.toBeNull();
    expect(document.querySelector(".post-title")).toBeNull();
  });

  it("draws no pill on a news post either — the horse heads every variant", () => {
    render(
      <PostCard
        post={{ ...TEXT_POST, media: { type: "news", posterUrl: null } }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    expect(document.querySelector(".post-badge")).toBeNull();
    expect(screen.getByText("Mahogany")).toHaveClass("post-horse");
    expect(document.querySelector(".post-panel")).not.toBeNull();
  });

  // Card selection is by `type`, exactly as in mobile's M4 table — a title is
  // not what makes a STABLE UPDATE card. And on a media card the title is not
  // drawn at all (client, 18 Aug 2026): the caption is the card's only copy.
  it("hides the title on a titled VIDEO post, with no pill and no panel", () => {
    render(
      <PostCard
        post={{ ...BASE, media: { type: "video", posterUrl: null, duration: "0:47" }, title: "Gallop day" }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
        onPlay={vi.fn()}
      />,
    );

    expect(screen.queryByText("Gallop day")).toBeNull();
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
    // The title is not rendered at all on a media card (client, 18 Aug 2026).
    expect(screen.queryByText("Gallop day")).toBeNull();
  });

  it("emits exactly one h3 on an update card too — the horse; no title at all", () => {
    render(<PostCard post={TEXT_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    const headings = document.querySelectorAll("article.post-web h3");
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveClass("post-horse");
    expect(document.querySelector(".post-title")).toBeNull();
  });

  // Defensive: A2 makes body required going forward, but whitespace is not null.
  it("renders no panel for a whitespace-only body", () => {
    render(
      <PostCard post={{ ...TEXT_POST, body: "   \n\n  \t " }} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />,
    );

    expect(screen.getByText("Mahogany")).toHaveClass("post-horse");
    expect(document.querySelector(".post-panel")).toBeNull();
  });
});

// THE REEL CARD, ported from mobile (client, 18 Aug 2026): a portrait VIDEO
// keeps its true ratio down to 9:16 and overlays the header on the frame;
// actions and caption stay below the media, and the classic white header row
// stands down. Portrait PHOTOS keep the classic 4:5 card.
describe("PostCard — the reel card", () => {
  const REEL: FeedPost = {
    ...BASE,
    body: "Morning trackwork.",
    media: { type: "video", posterUrl: null, duration: "0:30", aspectRatio: 9 / 16 },
  };

  const renderReel = (post: FeedPost, extra: Partial<Parameters<typeof PostCard>[0]> = {}) =>
    render(
      <PostCard post={post} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={vi.fn()} {...extra} />,
    );

  // ROUND 6 / ENG-761 item 1 — the pill must draw on ALL web card variants, and
  // the reel head is the SECOND of the two render sites. Without this the site
  // is invisible to the suite: deleting it left 755/755 green, and the preview
  // gallery has no reel fixture, so the e2e does not cover it either.
  it("draws the label pill inside the reel head, not only on the classic card", () => {
    const { container } = renderReel({ ...REEL, label: "Trackwork" });

    const badge = container.querySelector(".reel-head .post-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("Trackwork");
    // It belongs to the overlaid head, not to a classic header row (which a
    // reel does not render at all).
    expect(container.querySelector(".post-head-web")).toBeNull();
  });

  it("draws no pill on a reel whose label is null", () => {
    const { container } = renderReel({ ...REEL, label: null });
    expect(container.querySelector(".post-badge")).toBeNull();
  });

  it("draws the FULL 9:16 box, tagged reel", () => {
    const { container } = renderReel(REEL);
    const box = container.querySelector<HTMLElement>(".post-media-web")!;
    expect(box.className).toBe("post-media-web reel");
    const [w, h = "1"] = box.style.aspectRatio.split("/").map((s) => s.trim());
    expect(Number(w) / Number(h)).toBeCloseTo(9 / 16, 4);
  });

  it("overlays the header on the media and hides the classic header row", () => {
    const { container } = renderReel(REEL);
    expect(container.querySelector(".reel-head")).not.toBeNull();
    expect(container.querySelector(".post-head-web")).toBeNull();
    expect(container.querySelector(".reel-head .reel-horse")!.textContent).toBe("Mahogany");
    // No "by" prefix here either.
    expect(container.querySelector(".reel-head .reel-byline")!.textContent).not.toMatch(/\bby\b/);
  });

  it("keeps actions and caption BELOW the media — this is not the fullscreen", () => {
    const { container } = renderReel(REEL);
    expect(container.querySelector(".post-actions-web, [class*='actions']")).not.toBeNull();
    expect(container.querySelector(".post-body-web")!.textContent).toBe("Morning trackwork.");
  });

  it("puts the Follow pill IN the reel header row, not in the media corner", () => {
    const { container } = renderReel(REEL, { canFollow: true, onFollow: vi.fn() });
    expect(container.querySelector(".reel-head .media-follow")).not.toBeNull();
    expect(container.querySelectorAll(".media-follow")).toHaveLength(1);
  });

  it("a portrait PHOTO keeps the classic card at the 4:5 clamp", () => {
    const { container } = renderReel({
      ...BASE,
      media: { type: "photo", posterUrl: null, aspectRatio: 9 / 16 },
    });
    expect(container.querySelector(".reel-head")).toBeNull();
    expect(container.querySelector(".post-head-web")).not.toBeNull();
    const box = container.querySelector<HTMLElement>(".post-media-web")!;
    expect(box.className).toBe("post-media-web tall");
  });

  it("a video with an UNKNOWN ratio keeps the classic card", () => {
    const { container } = renderReel({
      ...BASE,
      media: { type: "video", posterUrl: null, duration: "0:12" },
    });
    expect(container.querySelector(".reel-head")).toBeNull();
    expect(container.querySelector(".post-head-web")).not.toBeNull();
  });

  it("mediaBoxProps only lifts the clamp for a VIDEO — the shared geometry stays safe", () => {
    expect(mediaBoxProps(0.5625, { video: true }).className).toBe("post-media-web reel");
    expect(mediaBoxProps(0.5625).className).toBe("post-media-web tall");
    expect(mediaBoxProps(1.7778, { video: true }).className).toBe("post-media-web");
  });
});

// ===========================================================================
// ROUND 6 / ENG-761 — the `.post-badge` pill returns as DATA (`post.label`),
// the photo chip mirrors the video duration chip, and the caption clamps to
// two lines with a "more" affordance.
// ===========================================================================

describe("PostCard — the label pill (ENG-761 item 1)", () => {
  it("renders the pill with the label's own text when post.label is set", () => {
    render(
      <PostCard post={{ ...BASE, label: "Trackwork" }} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />,
    );

    const badge = document.querySelector(".post-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("Trackwork");
  });

  it("renders no pill when post.label is null", () => {
    render(<PostCard post={{ ...BASE, label: null }} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);
    expect(document.querySelector(".post-badge")).toBeNull();
  });

  it("renders no pill when post.label is absent entirely", () => {
    render(<PostCard post={BASE} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);
    expect(document.querySelector(".post-badge")).toBeNull();
  });

  // The pill is COPY chosen at compose time; it is independent of the caption,
  // which is its own affordance underneath the reaction bar.
  it("shows the pill alongside a long caption at the same time — the two are independent", () => {
    const longBody =
      "This caption runs on for quite a while, well past what two lines of the clamped column could ever hold, so it stands in for a genuinely long post body.";
    render(
      <PostCard
        post={{ ...BASE, label: "Race Replay", body: longBody }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    const badge = document.querySelector(".post-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("Race Replay");
    expect(screen.getByTestId("post-caption")).toBeInTheDocument();
  });
});

describe("PostCard — the photo chip mirrors the video duration chip (ENG-761 item 3)", () => {
  it("shows the photo chip, and no duration chip, on a photo post", () => {
    render(
      <PostCard
        post={{ ...BASE, media: { type: "photo", posterUrl: null } }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    expect(screen.getByTestId("media-photo-chip")).toBeInTheDocument();
    expect(document.querySelector(".media-duration")).toBeNull();
  });

  it("shows the duration chip, and no photo chip, on a video post", () => {
    render(
      <PostCard
        post={{ ...BASE, media: { type: "video", posterUrl: null, duration: "0:47" } }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
        onPlay={vi.fn()}
      />,
    );

    expect(document.querySelector(".media-duration")).not.toBeNull();
    expect(screen.queryByTestId("media-photo-chip")).not.toBeInTheDocument();
  });
});

describe("PostCaption (ENG-761 item 2)", () => {
  it("carries the clamped class by default", () => {
    render(<PostCaption body="Trackwork this morning." />);
    const caption = screen.getByTestId("post-caption");
    expect(caption).toHaveClass("post-caption");
    expect(caption).toHaveClass("clamped");
  });

  // An update card's body IS the panel, so it is never also a caption.
  it("renders no caption at all for an update-type (STABLE UPDATE) card", () => {
    render(<PostCard post={TEXT_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);
    expect(screen.queryByTestId("post-caption")).not.toBeInTheDocument();
  });

  // jsdom lays out nothing, so `scrollHeight`/`clientHeight` both report 0 and
  // the "more" affordance can never appear naturally — the measurement itself
  // has to be stubbed to exercise either branch.
  describe("the scrollHeight/clientHeight measurement, stubbed", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('offers "more" when the full text overflows the clamp, and expands in place on click', async () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100);
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);

      const user = userEvent.setup();
      render(<PostCaption body="A caption long enough to overflow the two-line clamp." />);

      // The visible word is "more", but its accessible name is "Expand caption"
      // (post-card.tsx) — disambiguated from the card's own "More" (⋯) options
      // button, which is also visible in a full PostCard render.
      const more = screen.getByRole("button", { name: "Expand caption" });
      expect(more).toHaveTextContent("more");
      expect(screen.getByTestId("post-caption")).toHaveClass("clamped");

      await user.click(more);

      expect(screen.queryByRole("button", { name: "Expand caption" })).not.toBeInTheDocument();
      expect(screen.getByTestId("post-caption")).not.toHaveClass("clamped");
      expect(screen.getByTestId("post-caption")).toHaveClass("post-caption");
    });

    // The ticket's named edge case: a caption landing on EXACTLY two lines
    // measures equal, not over, and must get no affordance at all.
    it('offers no "more" when the caption lands on exactly two lines (scrollHeight === clientHeight)', () => {
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(40);
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);

      render(<PostCaption body="A caption that lands on exactly two lines, no more, no less." />);

      expect(screen.queryByRole("button", { name: "Expand caption" })).not.toBeInTheDocument();
      expect(screen.getByTestId("post-caption")).toHaveClass("clamped");
    });

    // THE CONTENT-LOSS GUARD. The first measurement runs against the FALLBACK
    // font. If the real face is wider the caption grows a third line — and the
    // ResizeObserver cannot see it, because `line-height` is unitless so the
    // clamped box stays exactly two lines tall and its border box never
    // changes, while `scrollHeight` grows underneath. Without the
    // `document.fonts.ready` re-measure the member is left with a silently
    // truncated caption and no way to open it.
    it("re-measures when the webfont lands, so a caption that only overflows after the swap still gets its 'more'", async () => {
      let fontsLoaded = false;
      // Fits on the fallback face, overflows once the real face applies.
      vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(40);
      vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => (fontsLoaded ? 100 : 40));

      let releaseFonts: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        releaseFonts = () => {
          fontsLoaded = true;
          resolve();
        };
      });
      // jsdom has no FontFaceSet; the component guards on `document.fonts?.ready`.
      Object.defineProperty(document, "fonts", { value: { ready }, configurable: true });

      render(<PostCaption body="A caption that only overflows once the real face loads." />);

      // Before the swap it measures as fitting, so no affordance — this half is
      // what makes the assertion below meaningful rather than trivially true.
      expect(screen.queryByRole("button", { name: "Expand caption" })).not.toBeInTheDocument();

      await act(async () => {
        releaseFonts();
        await ready;
      });

      expect(screen.getByRole("button", { name: "Expand caption" })).toBeInTheDocument();

      Reflect.deleteProperty(document, "fonts");
    });
  });
});

// ===========================================================================
// ENG-958 — the head avatar (a photo or a monogram fallback), the head STACK
// order, and the panel's line-clamp arithmetic + Read more/Read less toggle.
// ===========================================================================

describe("panelLineCount — pure arithmetic, no DOM", () => {
  it("returns 0 for a zero lineHeight — never divides by zero", () => {
    expect(panelLineCount([], 0)).toBe(0);
    expect(panelLineCount([58.5], 0)).toBe(0);
  });

  // A browser has been seen to report a three-line paragraph as 58.500001, and
  // `Math.round` (not `Math.ceil`) is what keeps that at 3 lines, not 4.
  it("rounds 58.500001 / 19.5 to 3 lines, not 4", () => {
    expect(panelLineCount([58.500001], 19.5)).toBe(3);
  });

  it("floors a sub-pixel paragraph height at 1 line, never 0", () => {
    expect(panelLineCount([0.4], 19.5)).toBe(1);
  });

  it("ignores an unmeasured (0 or negative) paragraph height, rather than counting it", () => {
    expect(panelLineCount([0, 19.5], 19.5)).toBe(1);
  });
});

describe("panelClampHeight — charges the between-paragraph gaps", () => {
  // THE point of the helper: three 4-line paragraphs at lineHeight 20, gap 12,
  // maxLines 8 → 4*20 + 12 + 4*20 = 172, NOT 8*20 = 160. Capping at
  // `maxLines * lineHeight` would swallow the gaps the member actually sees.
  it("charges a gap for each paragraph boundary it crosses", () => {
    const heights = [80, 80, 80]; // 4 lines each at lineHeight 20
    expect(panelClampHeight(heights, 20, 12, 8)).toBe(172);
  });

  it("never pays for a gap a budget that runs out mid-paragraph does not reach", () => {
    // One 4-line paragraph, then a second that would need more than the
    // remaining budget (maxLines 6): the first paragraph's gap IS paid (it
    // was reached); nothing beyond the second paragraph's partial 2 lines is.
    const heights = [80, 200]; // 4 lines, then 10 lines
    // 4 lines (80) + gap (12) + 2 lines (40) = 132 — the third paragraph
    // (absent here) would have paid ANOTHER gap only if reached.
    expect(panelClampHeight(heights, 20, 12, 6)).toBe(132);
  });

  it("returns 0 when nothing has been measured — 'do not clamp yet', not 'clamp to nothing'", () => {
    expect(panelClampHeight([], 20)).toBe(0);
    expect(panelClampHeight([80], 0)).toBe(0);
  });

  it("uses the module's own PANEL_CLAMP_LINES/PANEL_PARAGRAPH_GAP as its defaults", () => {
    expect(PANEL_CLAMP_LINES).toBe(8);
    expect(PANEL_PARAGRAPH_GAP).toBe(12);
    const heights = [160]; // 8 lines exactly at lineHeight 20
    expect(panelClampHeight(heights, 20)).toBe(160);
  });
});

describe("PostCard — the head STACK order (ENG-958 parity item)", () => {
  const STACKED: FeedPost = {
    ...BASE,
    raceBadge: { kind: "result", text: "Won R4" },
    label: "Trackwork",
  };

  it("orders the classic head: .race-badge, .post-horse, .post-byline, then .post-badge", () => {
    render(<PostCard post={STACKED} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    const meta = document.querySelector(".post-meta-web");
    expect(meta).not.toBeNull();
    const children = Array.from(meta!.children);
    const classesInOrder = children.map((el) => el.className);

    const badgeIdx = classesInOrder.findIndex((c) => c.includes("race-badge"));
    const horseIdx = classesInOrder.findIndex((c) => c.includes("post-horse"));
    const bylineIdx = classesInOrder.findIndex((c) => c.includes("post-byline"));
    const pillIdx = classesInOrder.findIndex((c) => c.includes("post-badge"));

    expect(badgeIdx).toBeGreaterThanOrEqual(0);
    expect(horseIdx).toBeGreaterThan(badgeIdx);
    expect(bylineIdx).toBeGreaterThan(horseIdx);
    expect(pillIdx).toBeGreaterThan(bylineIdx);

    // Positional, not merely present: `compareDocumentPosition` confirms the
    // pill genuinely FOLLOWS the byline in the tree, not just in the array.
    const byline = meta!.querySelector(".post-byline")!;
    const pill = meta!.querySelector(".post-badge")!;
    expect(byline.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(pill).toHaveClass("stacked");
  });

  it("orders the reel head the same way: .reel-horse, .reel-byline, then .post-badge", () => {
    const REEL: FeedPost = {
      ...STACKED,
      media: { type: "video", posterUrl: null, duration: "0:30", aspectRatio: 9 / 16 },
    };
    const { container } = render(
      <PostCard post={REEL} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={vi.fn()} />,
    );

    const meta = container.querySelector(".reel-head-meta");
    expect(meta).not.toBeNull();
    const children = Array.from(meta!.children).map((el) => el.className);

    const horseIdx = children.findIndex((c) => c.includes("reel-horse"));
    const bylineIdx = children.findIndex((c) => c.includes("reel-byline"));
    const pillIdx = children.findIndex((c) => c.includes("post-badge"));

    expect(horseIdx).toBe(0);
    expect(bylineIdx).toBeGreaterThan(horseIdx);
    expect(pillIdx).toBeGreaterThan(bylineIdx);

    const byline = meta!.querySelector(".reel-byline")!;
    const pill = meta!.querySelector(".post-badge")!;
    expect(byline.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pill).toHaveClass("stacked");
  });
});

describe("PostAvatar (via PostCard) — photo with a monogram fallback", () => {
  it("renders the horse's signed photo, not a monogram, when horsePhotoUrl is set", () => {
    render(
      <PostCard
        post={{ ...BASE, horsePhotoUrl: "https://sb.local/signed/horse.jpg" }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    const img = screen.getByTestId("post-avatar-photo");
    expect(img).toHaveAttribute("src", "https://sb.local/signed/horse.jpg");
    // The monogram box is a plain aria-hidden div with no `img` role — its
    // absence here is what proves the photo branch, not the fallback, rendered.
    expect(document.querySelector(".post-head-web > div.post-avatar-web:not(img)")).toBeNull();
  });

  it("falls back to the monogram when there is no horsePhotoUrl", () => {
    render(
      <PostCard post={{ ...BASE, horsePhotoUrl: null }} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />,
    );

    expect(screen.queryByTestId("post-avatar-photo")).not.toBeInTheDocument();
    const monogram = document.querySelector(".post-head-web .post-avatar-web");
    expect(monogram).not.toBeNull();
    expect(monogram!.textContent).toBe("M"); // Mahogany
  });

  it("falls back to the monogram when the photo element fires an error (revoked/rotated object)", () => {
    render(
      <PostCard
        post={{ ...BASE, horsePhotoUrl: "https://sb.local/signed/dead.jpg" }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    const img = screen.getByTestId("post-avatar-photo");
    fireEvent.error(img);

    expect(screen.queryByTestId("post-avatar-photo")).not.toBeInTheDocument();
    const monogram = document.querySelector(".post-head-web .post-avatar-web");
    expect(monogram).not.toBeNull();
    expect(monogram!.textContent).toBe("M");
  });

  it("uses trainerPhotoUrl, not horsePhotoUrl, for the head avatar on an update card", () => {
    const { container } = render(
      <PostCard
        post={{ ...TEXT_POST, horsePhotoUrl: "https://sb.local/signed/horse.jpg", trainerPhotoUrl: "https://sb.local/signed/trainer.jpg" }}
        viewerId={VIEWER_ID}
        onReact={noop}
        onBookmark={noop}
      />,
    );

    // Two `post-avatar-photo` elements render on an update card: the HEAD
    // avatar and the panel-footer disc. Both take the trainer's photo here
    // (correctly — this asserts the HEAD one specifically), so this must be
    // scoped to `.post-head-web` rather than `getByTestId`.
    const img = container.querySelector<HTMLImageElement>(".post-head-web [data-testid='post-avatar-photo']");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://sb.local/signed/trainer.jpg");
  });
});

describe("PostPanel — Read more / Read less toggle", () => {
  // jsdom lays out nothing, so every `getBoundingClientRect()` is 0 and the
  // clamp never naturally engages. Stub the measurement instead of chasing a
  // real layout: the probe reports one 20px line, and every paragraph reports
  // 200px (10 lines, over the 8-line budget), so the affordance is forced on.
  const LONG_UPDATE: FeedPost = {
    ...TEXT_POST,
    body: "Paragraph one runs on for a good while.\n\nParagraph two also runs on for a good while.",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubMeasurement() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = this.hasAttribute("data-testid") && this.getAttribute("data-testid") === "post-panel-line-probe"
        ? 20
        : this.tagName === "P"
          ? 200
          : 0;
      return { width: 100, height, top: 0, left: 0, bottom: height, right: 100, x: 0, y: 0, toJSON() {} } as DOMRect;
    });
  }

  it('offers "Read more" (no trailing dots), toggles to "Read less" and back, and flips aria-expanded', async () => {
    stubMeasurement();
    const user = userEvent.setup();
    render(<PostCard post={LONG_UPDATE} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    const more = await screen.findByTestId("post-panel-read-more");
    // Exact match, not a substring: the trailing "…" was deliberately removed
    // (26 Aug 2026) — "Read more…" reads as copy trailing off, not a control.
    expect(more.textContent).toBe(READ_MORE_LABEL);
    expect(more).toHaveAttribute("aria-expanded", "false");

    await user.click(more);
    expect(screen.getByTestId("post-panel-read-more").textContent).toBe(READ_LESS_LABEL);
    expect(screen.getByTestId("post-panel-read-more")).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByTestId("post-panel-read-more"));
    expect(screen.getByTestId("post-panel-read-more").textContent).toBe(READ_MORE_LABEL);
    expect(screen.getByTestId("post-panel-read-more")).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the Read more control OUTSIDE the clamped box — a clamped box must never contain its own unclamp control", async () => {
    stubMeasurement();
    render(<PostCard post={LONG_UPDATE} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />);

    const more = await screen.findByTestId("post-panel-read-more");
    expect(more.closest(".post-panel-clamp")).toBeNull();
  });
});
