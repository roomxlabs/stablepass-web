"use client";

/**
 * post-media — how a carousel gets its slides (round 6 / ENG-762, repointed by
 * ENG-815 onto the mint helper this file used to bypass).
 *
 * WHAT THIS FILE USED TO DO, AND WHY IT COULD NOT SURVIVE THE MERGE. ENG-762
 * read `post_media` directly from a client island under RLS and signed each
 * slide with `signPhotoMap(sb, POST_MEDIA_BUCKET, …)`. ENG-800 then revoked
 * member SELECT on that bucket and ENG-799 routed every post-media byte through
 * `POST /api/posts/media`, so `signPhotoMap` is now deny-by-construction for
 * `post-media` and returns an empty map. Keeping the old body across the merge
 * would therefore have compiled, type-checked and rendered — as a carousel whose
 * every slide is `null`. That is the "signs a revoked bucket" half of ENG-815.
 *
 * WHAT IT DOES NOW. Slides are addressed as `{ postId, slideIndex }` and minted
 * one at a time by the server (ENG-809 decision 2). NO STORAGE PATH IS EVER
 * CONSTRUCTED OR SENT from here — that property, not the secrecy of a path, is
 * what stops a member minting another post's or a draft's objects, because the
 * server resolves the path itself under the caller's own RLS.
 *
 * PREFETCH ONE AHEAD (ENG-809 decision 1). Slide 0 is never requested here: it
 * arrives in the feed page's existing batch, alongside the `slideCount` that
 * draws the dots. This hook mints the ACTIVE slide and the one after it, so a
 * mounted carousel costs one extra URL and a swipe costs one more — roughly two
 * per post rather than the ten an eager mint would burn, ~190 of which per feed
 * page nobody ever looks at.
 *
 * "Once the post is on screen" is approximated by MOUNT, deliberately. A
 * carousel only mounts for a post with 2+ slides, which is rare, and this app
 * has no IntersectionObserver anywhere (nor does jsdom, like `ResizeObserver` —
 * see `PostCaption`). Mount-time is therefore the honest reading of the locked
 * decision's intent — "roughly 2 URLs per post" — without inventing a second
 * visibility mechanism beside the one the card already lacks.
 */
import { useEffect, useRef, useState } from "react";
import { fetchPostMediaSlide } from "@/lib/api/post-media";

/**
 * The highest addressable slide ordinal. Mirrors the be's own bound — the
 * `post_media_sort_order_range check (sort_order between 0 and 9)` that
 * `supabase/functions/post-media/index.ts` re-states as `MAX_SLIDE_INDEX` — so
 * this client never asks for an index the server would reject as malformed.
 * Restated here rather than imported: web and be are separate codebases and a
 * "see the other repo" reference is how they drift.
 */
export const MAX_SLIDE_INDEX = 9;

/** One more than `MAX_SLIDE_INDEX`: the most slides a post can carry. */
export const MAX_SLIDE_COUNT = MAX_SLIDE_INDEX + 1;

/**
 * The batch's `slideCount`, made safe to draw with.
 *
 * The value arrives over the wire from an untyped JSON body, and the be derives
 * it as HIGHEST ORDINAL + 1 rather than a row count — deliberately, so a
 * non-contiguous `{0, 2}` reports 3 and the client skips a gap instead of losing
 * a photo. That means it is an upper bound, not a promise that every index
 * resolves: index 1 of `{0, 2}` comes back `null` and draws a blank slide. The
 * floor is 1 because "no `post_media` rows" and "one photo" are the same
 * rendering case (ENG-809 decision 3) — `post.media_url` mirrors slide 0.
 */
export function clampSlideCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  const whole = Math.floor(value);
  if (whole < 1) return 1;
  return Math.min(MAX_SLIDE_COUNT, whole);
}

/**
 * The slides minted so far, keyed by index. Absent means "not minted": either
 * not asked for yet, or asked and refused. Those two are deliberately the SAME
 * rendering state — a blank slide — because distinguishing them on screen is
 * exactly how a draft's existence would leak.
 *
 * Slide 0 is NOT in this map. It comes from the page batch and is passed to the
 * carousel separately, so the two sources can never disagree about index 0.
 */
export type MintedSlides = ReadonlyMap<number, string>;

/**
 * Mint the active slide and the next one, once each.
 *
 * `asked` is a ref, not state: an index must be marked before its request is
 * awaited or a re-render between the two fires a second identical mint. A slide
 * that comes back `null` STAYS asked and is never retried — a draft, a gap in
 * `sort_order`, or a gated slide must cost one refusal, not one per scroll.
 *
 * Recovery from a genuinely EXPIRED slide is not this hook's job: that is the
 * `<img>`'s own `onError` (ENG-813), which re-mints by index through
 * `PostMediaImage`.
 *
 * ONE CASE FALLS BETWEEN THE TWO, stated plainly because the sentence above
 * would otherwise imply it is covered. The three refusals named are permanent,
 * but a TRANSIENT network failure on the prefetch also returns `null`
 * (`fetchPostMediaSlide` catches and returns null), and it is treated the same:
 * marked asked, never retried. The `onError` path cannot pick it up either,
 * because with no url `PostMediaImage` renders the placeholder and there is no
 * `<img>` to fail. So that slide stays blank for the life of the mount, and
 * heals on the next navigation. Slide 0 is unaffected — it paints an `<img>`
 * from the batch and therefore does have an `onError`. Accepted rather than
 * fixed: a retry here needs a backoff to avoid becoming the request storm
 * ENG-813's cap exists to prevent, and a blank slide beside its siblings is a
 * far smaller defect than a feed that re-requests on every scroll.
 */
export function usePostSlides(postId: string, slideCount: number, active: number): MintedSlides {
  const total = clampSlideCount(slideCount);
  const [minted, setMinted] = useState<MintedSlides>(() => new Map());
  const asked = useRef<Set<number>>(new Set());

  // Reset when this element is reused for a DIFFERENT post. Defensive rather
  // than currently exercised — every carousel mounts under a post-keyed card —
  // but a stale slide map is a photo from the wrong horse, so it is cheap
  // insurance. Same "adjust state on a prop change" shape as `PostMediaImage`:
  // the setState pair happens in render, the REF mutation in the effect below,
  // because mutating a ref during render is unsound (`react-hooks/refs`).
  const [seenPost, setSeenPost] = useState(postId);
  if (postId !== seenPost) {
    setSeenPost(postId);
    setMinted(new Map());
  }
  useEffect(() => {
    asked.current = new Set();
  }, [seenPost]);

  useEffect(() => {
    // Index 0 is excluded BY CONSTRUCTION, not by luck: it is already minted in
    // the page batch, and re-requesting it here would double every feed page's
    // mint traffic for no new pixel.
    const wanted = [active, active + 1].filter(
      (i) => i >= 1 && i < total && i <= MAX_SLIDE_INDEX && !asked.current.has(i),
    );
    if (wanted.length === 0) return;
    for (const i of wanted) asked.current.add(i);

    let cancelled = false;
    void Promise.all(
      wanted.map(async (i) => {
        const url = await fetchPostMediaSlide(postId, i);
        if (cancelled || !url) return;
        setMinted((prev) => {
          if (prev.get(i) === url) return prev;
          const next = new Map(prev);
          next.set(i, url);
          return next;
        });
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [postId, seenPost, active, total]);

  return minted;
}
