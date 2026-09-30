"use client";

/**
 * use-feed-prefetch — what the five member feeds do AHEAD of the member
 * (ENG-1633, PF-W1). Two jobs, both driven by IntersectionObserver over the
 * feed's own cards:
 *
 *   1. NEXT PAGE EARLY. Page N+1 starts when the 5th-from-last card comes into
 *      view — i.e. with <= 5 cards left below the viewport — instead of when the
 *      member hits the bottom and waits. The end-of-list sentinel stays as the
 *      fallback (a page too short to have a 5th-from-last card, or a Saved page
 *      whose rows were all RLS-hidden and drew no card). ONE request per page:
 *      whichever of the two fires first claims `posts.length:cursor`, and the
 *      other can never request that page again.
 *   2. PLAYBACK PRE-MINT. The card on screen and the one after it are handed to
 *      `playback.prefetch`, which mints their urls into memory so the tap needs
 *      no request (see use-feed-playback for the guardrails on that).
 *
 * FINDING THE CARDS. Every post a feed draws is exactly ONE `article.post-web`
 * (the PostCard root, or the inline player article that replaces it while that
 * post plays), in `posts` order. The cards are found under the SENTINEL's parent
 * — the feed column — so no card component needs a ref. If the count ever stops
 * matching `posts`, both card-driven jobs stand down and only the sentinel runs:
 * mis-mapped cards would prefetch the wrong post, which is worse than none.
 *
 * NOTHING HERE FETCHES OR RENDERS. It calls the feed's own `loadMore` (whose
 * one-in-flight guard it relies on) and `playback.prefetch` — nothing else.
 */
import { useEffect, useRef, type RefObject } from "react";
import type { FeedPost } from "@/components/types";
import type { FeedPlayback } from "@/lib/feed/use-feed-playback";

/** Start page N+1 when this many cards (or fewer) remain below the viewport. */
export const PREFETCH_CARDS_LEFT = 5;

/** The card whose appearance starts page N+1: the 5th from last (0 on a short page). */
export function prefetchTriggerIndex(count: number): number {
  return Math.max(0, count - PREFETCH_CARDS_LEFT);
}

/**
 * The card the member is looking at, from each card's visible ratio: the FIRST
 * that is at least half on screen, else the most visible one; null if none is.
 * (A tall reel may never reach half, which is why the fallback exists.)
 */
export function pickActiveCard(ratios: ReadonlyMap<number, number>): number | null {
  let best: number | null = null;
  let bestRatio = 0;
  let firstHalf: number | null = null;
  for (const [i, r] of ratios) {
    if (r >= 0.5 && (firstHalf === null || i < firstHalf)) firstHalf = i;
    if (r > bestRatio || (r === bestRatio && r > 0 && best !== null && i < best)) {
      best = i;
      bestRatio = r;
    }
  }
  return firstHalf ?? (bestRatio > 0 ? best : null);
}

/** The posts to pre-mint for: the active card and the next one, video posts only. */
export function premintTargets(posts: Pick<FeedPost, "id" | "media">[], active: number): string[] {
  const out: string[] = [];
  for (const i of [active, active + 1]) {
    const p = posts[i];
    if (p && p.media.type === "video") out.push(p.id);
  }
  return out;
}

/** The feed's cards, in document order, under the sentinel's parent. */
function feedCards(sentinel: HTMLElement): HTMLElement[] {
  const root = sentinel.parentElement;
  return root ? Array.from(root.querySelectorAll<HTMLElement>("article.post-web")) : [];
}

export interface FeedPrefetchOptions {
  /** The feed's end-of-list sentinel; rendered whenever the feed shows posts. */
  sentinelRef: RefObject<HTMLElement | null>;
  posts: FeedPost[];
  playback: FeedPlayback;
  /** More pages exist and none is loading / walled / errored. */
  canLoadMore: boolean;
  /** The cursor page N+1 would be requested with — part of its one-shot key. */
  cursor: string | null;
  /** Request page N+1 (the feed's own fetch, with its own in-flight guard). */
  loadMore: () => void;
}

export function useFeedPrefetch({ sentinelRef, posts, playback, canLoadMore, cursor, loadMore }: FeedPrefetchOptions): void {
  // Latest callbacks through refs, so an observer never calls a stale closure
  // and a re-render never has to rebuild one.
  const loadMoreRef = useRef(loadMore);
  const prefetchRef = useRef(playback.prefetch);
  const postsRef = useRef(posts);
  useEffect(() => {
    loadMoreRef.current = loadMore;
    prefetchRef.current = playback.prefetch;
    postsRef.current = posts;
  });

  // The page already requested — `posts.length:cursor`. Survives StrictMode's
  // effect re-run (a ref), and is never reset: a later page has a new key.
  const requested = useRef<string | null>(null);
  const pageKey = `${posts.length}:${cursor ?? ""}`;
  // A playing post swaps its PostCard for the inline player article, so the
  // observed elements must be re-found whenever that changes.
  const playingKey = playback.playingKey;

  // 1 — next page at <= 5 cards left (or at the sentinel, whichever is first).
  useEffect(() => {
    if (!canLoadMore || typeof IntersectionObserver === "undefined") return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const cards = feedCards(sentinel);
    const targets: Element[] = [sentinel];
    if (cards.length > 0 && cards.length === posts.length) targets.push(cards[prefetchTriggerIndex(cards.length)]);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (requested.current === pageKey) return;
        requested.current = pageKey;
        observer.disconnect();
        loadMoreRef.current();
      },
      // The sentinel's old 200px lead, kept for both targets.
      { rootMargin: "0px 0px 200px 0px" },
    );
    for (const t of targets) observer.observe(t);
    return () => observer.disconnect();
  }, [canLoadMore, pageKey, posts.length, sentinelRef, playingKey]);

  // 2 — pre-mint playback for the card on screen + the next one.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const sentinel = sentinelRef.current;
    if (!sentinel || posts.length === 0) return;
    const cards = feedCards(sentinel);
    if (cards.length !== posts.length) return;
    const indexOf = new Map<Element, number>(cards.map((c, i) => [c, i]));
    const ratios = new Map<number, number>();
    let last = "";
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = indexOf.get(e.target);
          if (i !== undefined) ratios.set(i, e.isIntersecting ? e.intersectionRatio : 0);
        }
        const active = pickActiveCard(ratios);
        if (active === null) return;
        const ids = premintTargets(postsRef.current, active);
        const sig = ids.join(",");
        if (sig === last) return;
        last = sig;
        prefetchRef.current(ids);
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const c of cards) observer.observe(c);
    return () => observer.disconnect();
  }, [posts, sentinelRef, playingKey]);
}
