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
import { useEffect, useRef, useState } from "react";
import { remintPostMedia } from "@/lib/api/post-media";

export interface PostMediaImageProps {
  /** The post whose media this is — the only id a re-mint asks for. */
  postId: string;
  /** The minted URL the screen resolved on its page fetch. */
  src?: string | null;
  /** A video poster re-mints from the playback route, a photo from post-media. */
  video?: boolean;
}

/** The no-media placeholder, unchanged from what the media box always drew. */
const Placeholder = () => <div style={{ width: "100%", height: "100%" }} />;

export function PostMediaImage({ postId, src, video = false }: PostMediaImageProps) {
  const [url, setUrl] = useState<string | null>(src ?? null);
  const [failed, setFailed] = useState(false);
  // A ref, not state: the cap must be read AND set inside one error handler
  // without waiting for a re-render, or a burst of error events would each see
  // a stale `false` and fire their own re-mint.
  const retried = useRef(false);
  // Track the prop so a genuine page re-fetch (a NEW minted url from the
  // screen) resets this element, retry budget included.
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
  }, [seenSrc]);

  async function handleError() {
    if (retried.current) {
      // Second failure — the terminal state is the placeholder, not a third GET.
      setFailed(true);
      return;
    }
    retried.current = true;
    const fresh = await remintPostMedia(postId, { video });
    // An identical URL would not re-trigger a load, leaving a broken element
    // that never errors again — treat it as no recovery at all.
    if (!fresh || fresh === url) {
      setFailed(true);
      return;
    }
    setUrl(fresh);
  }

  if (failed || !url) return <Placeholder />;

  return (
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary Storage/Mux poster URL, cover-fit
    <img src={url} alt="" onError={() => { void handleError(); }} />
  );
}
