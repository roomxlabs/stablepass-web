"use client";

// post-media-image — the <img> for a post's minted photo/poster, plus the ONE
// recovery attempt behind it (ENG-813).
//
// A minted post-media URL lives 300s (ENG-796 narrowed it from 3600s so an
// unpublished post's bytes stay reachable for as short a window as possible).
// Nothing re-minted it, so a tab left open past five minutes, a bfcache restore
// or any re-request painted an empty box: the browser failed the GET and the
// element rendered nothing at all.
//
// The fix is the element's own `onError`, NOT a timer and NOT an `expiresAt`
// comparison. The image failing IS the signal — the only one that stays correct
// across sleep, clock skew and a slow network — and it heals a transient
// network failure for free. `expiresAt` is deliberately not consulted here.
//
// Exactly ONE retry per element, then the same empty placeholder the no-media
// case has always drawn. Unbounded retry against a genuinely dead URL is a
// request storm.
//
// "Once" is scoped to a load attempt, not to the element's whole lifetime: a
// SUCCESSFUL render returns the budget (see `onLoad` below). Minted urls live
// 300s, so a long-lived tab expires over and over, and a budget that never
// reset would fix only the FIRST expiry and then sit on a permanent
// placeholder — visually identical to the bug this file exists to remove.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { remintPostMedia } from "@/lib/api/post-media";

export interface PostMediaImageProps {
  /** The post whose media this is — the only id a re-mint asks for. */
  postId: string;
  /** The minted URL the screen resolved on its page fetch. */
  src?: string | null;
  /** A video poster re-mints from the playback route, a photo from post-media. */
  video?: boolean;
  /**
   * WHICH slide of the post this element draws (ENG-815). Omitted / 0 is the
   * post's own `media_url`, which is what every single-photo and video card
   * passes and is why their behaviour is untouched. A carousel slide passes its
   * ordinal so the re-mint below asks for THAT slide by index — re-minting the
   * batch would otherwise hand slide 3 the url of slide 0.
   */
  slideIndex?: number;
  /**
   * What to draw with no url — before the first mint, and after a failed retry.
   * Defaults to the empty box the media ground has always drawn. The carousel
   * overrides it so a dead slide keeps its own `.photo-slide-empty` styling
   * instead of silently becoming a differently-classed empty div.
   */
  placeholder?: ReactNode;
}

/** The no-media placeholder, unchanged from what the media box always drew. */
const Placeholder = () => <div style={{ width: "100%", height: "100%" }} />;

export function PostMediaImage({
  postId,
  src,
  video = false,
  slideIndex = 0,
  placeholder,
}: PostMediaImageProps) {
  const [url, setUrl] = useState<string | null>(src ?? null);
  const [failed, setFailed] = useState(false);
  // A ref, not state: the cap must be read AND set inside one error handler
  // without waiting for a re-render, or a burst of error events would each see
  // a stale `false` and fire their own re-mint.
  const retried = useRef(false);
  // Bumped whenever the screen delivers a NEW src. An in-flight re-mint that
  // resolves after a bump belongs to a previous generation, and its result —
  // fresh url OR failure — must be dropped: writing it would stomp, or blank,
  // the newer authoritative url and reintroduce the very empty box this fixes.
  const generation = useRef(0);
  // Track the prop so a genuine page re-fetch (a NEW minted url from the
  // screen) resets this element, retry budget included.
  //
  // DEFENSIVE, not currently exercised: as of ENG-813 no member screen mutates
  // a MOUNTED card's posterUrl (pagination appends, react/bookmark patch only
  // their own fields, and a reload goes through setPosts([]) which unmounts).
  // It exists so that adding a refresh/poll later does not silently strand
  // this element on a stale url.
  const [seenSrc, setSeenSrc] = useState(src ?? null);
  if ((src ?? null) !== seenSrc) {
    setSeenSrc(src ?? null);
    setUrl(src ?? null);
    setFailed(false);
  }
  // The retry-budget reset lives in an effect, not the render-phase branch
  // above: a ref mutation during render is unsound (`react-hooks/refs`) even
  // though the sibling `setState` calls are the documented "adjust state on a
  // prop change" pattern. Effects run before the browser can dispatch the
  // NEXT `onError`, so the budget is still reset in time for it — same
  // behaviour, just off the render phase.
  useEffect(() => {
    retried.current = false;
    generation.current += 1;
  }, [seenSrc]);

  async function handleError() {
    if (retried.current) {
      // Second failure — the terminal state is the placeholder, not a third GET.
      setFailed(true);
      return;
    }
    retried.current = true;
    const mine = generation.current;
    const fresh = await remintPostMedia(postId, { video, slideIndex });
    // A newer src landed from the screen while this was in flight. That url is
    // authoritative and already rendering; this result is stale. Dropping it
    // matters most in the failure case: writing setFailed(true) here would
    // blank a perfectly good, freshly-minted image.
    if (mine !== generation.current) return;
    // An identical URL would not re-trigger a load, leaving a broken element
    // that never errors again — treat it as no recovery at all.
    if (!fresh || fresh === url) {
      setFailed(true);
      return;
    }
    // Clearing `failed` is load-bearing. If two error events raced this
    // re-mint, the second already latched failed=true; without this line the
    // recovered url would be thrown away and the element would sit on the
    // placeholder forever — "retry once" silently degraded to "retry never".
    setFailed(false);
    setUrl(fresh);
  }

  if (failed || !url) return <>{placeholder ?? <Placeholder />}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary Storage/Mux poster URL, cover-fit
    <img
      src={url}
      alt=""
      onLoad={() => {
        // A successful render returns the retry budget. This is what makes
        // recovery DURABLE rather than one-shot, and it is deliberate — not a
        // hole in the cap above.
        //
        // The argument, because it is not obvious at a glance: a dead url
        // never fires `onLoad`, so it can never earn a reset. The worst case
        // is therefore one failed request per SUCCESSFUL render, which is
        // self-limiting — a render that never succeeds never grants another
        // attempt. That is a strictly stronger guarantee than a time-based or
        // count-based budget, and it needs no timer, no `expiresAt` and no
        // shared cache.
        //
        // Do not "fix" this back by deleting it: test/post-media-remint's
        // "recovers from a SECOND expiry" case fails without it, and the
        // storm case ("stops after ONE retry") deliberately never fires load,
        // which is what proves a dead url stays capped.
        retried.current = false;
      }}
      onError={() => { void handleError(); }}
    />
  );
}
