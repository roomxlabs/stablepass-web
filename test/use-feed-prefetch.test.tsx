// ENG-1633 — the feeds' look-ahead: page N+1 at <= 5 cards left, and the
// playback pre-mint for the card on screen + the next one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import type { FeedPost } from "@/components/types";
import type { FeedPlayback } from "@/lib/feed/use-feed-playback";
import {
  PREFETCH_CARDS_LEFT,
  pickActiveCard,
  prefetchTriggerIndex,
  premintTargets,
  useFeedPrefetch,
} from "@/lib/feed/use-feed-prefetch";
import {
  MockIntersectionObserver,
  installIntersectionObserver,
  intersect,
  liveObservers,
} from "./support/intersection-observer";

describe("prefetchTriggerIndex", () => {
  it("is the 5th-from-last card, clamped to 0 on a short page", () => {
    expect(PREFETCH_CARDS_LEFT).toBe(5);
    expect(prefetchTriggerIndex(12)).toBe(7);
    expect(prefetchTriggerIndex(5)).toBe(0);
    expect(prefetchTriggerIndex(3)).toBe(0);
    expect(prefetchTriggerIndex(0)).toBe(0);
  });
});

describe("pickActiveCard", () => {
  it("the FIRST card at least half visible wins", () => {
    expect(pickActiveCard(new Map([[3, 0.9], [1, 0.5], [2, 0.6]]))).toBe(1);
  });
  it("falls back to the most visible card when none reaches half", () => {
    expect(pickActiveCard(new Map([[1, 0.2], [2, 0.4], [3, 0.1]]))).toBe(2);
  });
  it("is null when nothing is visible", () => {
    expect(pickActiveCard(new Map([[1, 0], [2, 0]]))).toBeNull();
    expect(pickActiveCard(new Map())).toBeNull();
  });
});

const post = (id: string, type: "video" | "photo" = "photo") =>
  ({ id, media: { type, posterUrl: "" } }) as unknown as FeedPost;

describe("premintTargets", () => {
  const posts = [post("p0"), post("v1", "video"), post("v2", "video"), post("p3")];
  it("names only VIDEO posts, at the active card and the one after", () => {
    expect(premintTargets(posts, 1)).toEqual(["v1", "v2"]);
    expect(premintTargets(posts, 0)).toEqual(["v1"]);
    expect(premintTargets(posts, 2)).toEqual(["v2"]);
    expect(premintTargets(posts, 3)).toEqual([]);
  });
  it("never runs off the end of the list", () => {
    expect(premintTargets(posts, 9)).toEqual([]);
  });
});

// ── the hook ────────────────────────────────────────────────────────────────

type HarnessProps = {
  posts: FeedPost[];
  canLoadMore: boolean;
  cursor: string | null;
  loadMore: () => void;
  playback: FeedPlayback;
};

function Harness({ posts, canLoadMore, cursor, loadMore, playback }: HarnessProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useFeedPrefetch({ sentinelRef, posts, playback, canLoadMore, cursor, loadMore });
  return (
    <div data-testid="column">
      {posts.map((p) => (
        <article key={p.id} className="post-web" data-id={p.id} />
      ))}
      <div ref={sentinelRef} data-testid="sentinel" />
    </div>
  );
}

const fakePlayback = () => ({ prefetch: vi.fn(), playingKey: null }) as unknown as FeedPlayback & { prefetch: ReturnType<typeof vi.fn> };

const photos = (n: number, from = 0) => Array.from({ length: n }, (_, i) => post(`p${from + i}`));
const cards = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>("article.post-web"));

let restoreIO: () => void;
beforeEach(() => {
  restoreIO = installIntersectionObserver();
});
afterEach(() => restoreIO());

describe("useFeedPrefetch — next page at <= 5 cards left", () => {
  it("firing the 5th-from-last card calls loadMore ONCE; firing again or the sentinel does not repeat it", () => {
    const loadMore = vi.fn();
    const playback = fakePlayback();
    const props = { posts: photos(12), canLoadMore: true, cursor: "c1", loadMore, playback };
    const { container } = render(<Harness {...props} />);

    const trigger = cards(container)[7];
    expect(intersect(trigger)).toBeGreaterThan(0);
    expect(loadMore).toHaveBeenCalledTimes(1);

    intersect(trigger);
    intersect(container.querySelector("[data-testid=sentinel]")!);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("an earlier card (index 6) does not trigger paging", () => {
    const loadMore = vi.fn();
    const { container } = render(
      <Harness posts={photos(12)} canLoadMore cursor="c1" loadMore={loadMore} playback={fakePlayback()} />,
    );
    // Card 6 is watched only by the visibility observer, never the paging one.
    intersect(cards(container)[6]);
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("the sentinel is the fallback: it alone claims the page, then the trigger card cannot re-request it", () => {
    const loadMore = vi.fn();
    const { container } = render(
      <Harness posts={photos(12)} canLoadMore cursor="c1" loadMore={loadMore} playback={fakePlayback()} />,
    );
    intersect(container.querySelector("[data-testid=sentinel]")!);
    expect(loadMore).toHaveBeenCalledTimes(1);
    intersect(cards(container)[7]);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("a page shorter than 5 cards pages from card 0", () => {
    const loadMore = vi.fn();
    const { container } = render(
      <Harness posts={photos(3)} canLoadMore cursor="c1" loadMore={loadMore} playback={fakePlayback()} />,
    );
    intersect(cards(container)[0]);
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("after a re-render with more posts and a NEW cursor, it can fire again", () => {
    const loadMore = vi.fn();
    const playback = fakePlayback();
    const { container, rerender } = render(
      <Harness posts={photos(12)} canLoadMore cursor="c1" loadMore={loadMore} playback={playback} />,
    );
    intersect(cards(container)[7]);
    expect(loadMore).toHaveBeenCalledTimes(1);

    rerender(<Harness posts={photos(22)} canLoadMore cursor="c2" loadMore={loadMore} playback={playback} />);
    intersect(cards(container)[17]);
    expect(loadMore).toHaveBeenCalledTimes(2);
  });

  it("canLoadMore=false: no paging observer (the sentinel is not observed at all)", () => {
    const loadMore = vi.fn();
    const { container } = render(
      <Harness posts={photos(12)} canLoadMore={false} cursor={null} loadMore={loadMore} playback={fakePlayback()} />,
    );
    const sentinel = container.querySelector("[data-testid=sentinel]")!;
    expect(liveObservers().some((o) => o.targets.has(sentinel))).toBe(false);
    intersect(sentinel);
    intersect(cards(container)[7]);
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("a non-intersecting entry does nothing", () => {
    const loadMore = vi.fn();
    const { container } = render(
      <Harness posts={photos(12)} canLoadMore cursor="c1" loadMore={loadMore} playback={fakePlayback()} />,
    );
    intersect(cards(container)[7], 0, false);
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("uses the LATEST loadMore, not the one from the first render", () => {
    const first = vi.fn();
    const second = vi.fn();
    const playback = fakePlayback();
    const posts = photos(12);
    const { container, rerender } = render(
      <Harness posts={posts} canLoadMore cursor="c1" loadMore={first} playback={playback} />,
    );
    rerender(<Harness posts={posts} canLoadMore cursor="c1" loadMore={second} playback={playback} />);
    intersect(cards(container)[7]);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("useFeedPrefetch — pre-mint for the card on screen + the next", () => {
  it("firing a card's visibility calls playback.prefetch with [active video, next video]", () => {
    const playback = fakePlayback();
    const posts = [post("p0"), post("v1", "video"), post("v2", "video"), post("p3")];
    const { container } = render(
      <Harness posts={posts} canLoadMore={false} cursor={null} loadMore={vi.fn()} playback={playback} />,
    );
    intersect(cards(container)[1], 0.8);
    expect(playback.prefetch).toHaveBeenCalledTimes(1);
    expect(playback.prefetch).toHaveBeenCalledWith(["v1", "v2"]);
  });

  it("does not re-issue an identical target set", () => {
    const playback = fakePlayback();
    const posts = [post("v0", "video"), post("v1", "video")];
    const { container } = render(
      <Harness posts={posts} canLoadMore={false} cursor={null} loadMore={vi.fn()} playback={playback} />,
    );
    intersect(cards(container)[0], 0.9);
    intersect(cards(container)[0], 1);
    expect(playback.prefetch).toHaveBeenCalledTimes(1);
  });

  it("stands down when the card count does not match posts (no mis-mapped prefetch)", () => {
    const playback = fakePlayback();
    // A harness whose posts prop is longer than the cards it draws.
    function Mismatch() {
      const ref = useRef<HTMLDivElement | null>(null);
      useFeedPrefetch({
        sentinelRef: ref,
        posts: [post("v0", "video"), post("v1", "video"), post("v2", "video")],
        playback,
        canLoadMore: false,
        cursor: null,
        loadMore: vi.fn(),
      });
      return (
        <div>
          <article className="post-web" />
          <div ref={ref} />
        </div>
      );
    }
    const { container } = render(<Mismatch />);
    expect(MockIntersectionObserver.all.some((o) => o.targets.size > 0)).toBe(false);
    intersect(container.querySelector("article")!);
    expect(playback.prefetch).not.toHaveBeenCalled();
  });
});
