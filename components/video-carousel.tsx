"use client";

// video-carousel — the multi-video media layer for a post (ENG-1599, MV-W1),
// the video twin of `photo-carousel.tsx` and the web half of mobile's MV-M1.
//
// SAME GEOMETRY AS THE PHOTO CAROUSEL, ON PURPOSE (owner: no mockup — reuse the
// photo carousel's dots and chip). It fills the card's existing
// `.post-media-web` box, pages with CSS scroll-snap (`.photo-track` /
// `.photo-slide`), draws the same `.photo-dots` and the same counted
// `.media-photo-chip` — with a play glyph instead of the photo glyph — and adds
// only what a video needs: a play button per slide and prev/next arrows on hover
// for a desktop pointer that cannot swipe.
//
// PLAYBACK LIVES IN THE FEED, NOT HERE. The feed's `useFeedPlayback` holds the
// ONE playing `postId:videoIndex` for the whole screen; this component asks it
// to play a slide and renders `HlsVideo` in the slide whose key is playing. That
// is what makes "starting a video in one card stops the one in another" true
// without the cards knowing about each other.
//
//   - Tap to play: mints `/api/posts/:id/playback?videoIndex=i` (index 0 keeps
//     the bare url). Still NO autoplay on load — nothing plays until a tap.
//   - Auto-advance: when a slide's video ends, scroll to the next slide and play
//     it. That `play()` lands outside any gesture, and a browser may refuse it
//     (`NotAllowedError`, e.g. Safari with sound): the slide then shows its
//     poster with our play button over it, and a tap starts it synchronously.
//     No error UI. The last slide stops.
//   - Swiping away from a playing slide stops it.
//
// GUARDRAILS. §6: the only url a slide ever plays is the one the feed's hook
// minted; this file never sees a Mux id, never builds a url, never stores one —
// it sends an ordinal. §3: a slide has no poster and no video until the server
// has answered 200; a 402 leaves the media ground and the feed's pill.
import { useCallback, useEffect, useRef, useState } from "react";
import { HlsVideo } from "./hls-video";
import { PostMediaImage } from "./post-media-image";
import { clampVideoCount, useVideoPosters } from "@/lib/post-media";
import type { FeedPlayback } from "@/lib/feed/use-feed-playback";

const Play = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8Z" fill="currentColor" stroke="none" /></svg>
);

/** The chip's glyph: a small play triangle, where the photo chip draws a frame. */
const VideoGlyph = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7Z" fill="currentColor" stroke="none" /></svg>
);

const Chevron = ({ dir }: { dir: "left" | "right" }) => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.25">
    <path d={dir === "left" ? "m15 18-6-6 6-6" : "m9 18 6-6-6-6"} />
  </svg>
);

/**
 * The counted chip, for videos. The SAME element and classes as the photo
 * carousel's `MediaPhotoChip` (`media-photo-chip counted`) so the two cannot
 * drift apart in the corner; only the glyph and the spoken name differ.
 */
export function MediaVideoChip({ index, total }: { index: number; total: number }) {
  return (
    <div
      className="media-photo-chip counted"
      data-testid="media-video-chip"
      role="img"
      aria-label={`Video ${index + 1} of ${total}`}
    >
      <VideoGlyph />
      <span className="media-photo-count" data-testid="media-video-count" aria-hidden="true">
        {index + 1}/{total}
      </span>
    </div>
  );
}

export interface VideoCarouselProps {
  /** The post these videos belong to — the only handle a mint ever sends. */
  postId: string;
  /** `videoCount` from the page's batch (ENG-1596): READY videos, 2..5 here. */
  videoCount: number;
  /** Video 0's poster, already minted with the page. */
  firstPoster?: string | null;
  /**
   * The feed's shared player. Optional so a no-auth gallery can draw the
   * carousel; without it the play buttons do nothing.
   */
  playback?: FeedPlayback;
}

export function VideoCarousel({ postId, videoCount, firstPoster = null, playback }: VideoCarouselProps) {
  const total = clampVideoCount(videoCount);
  const trackRef = useRef<HTMLDivElement | null>(null);
  // The VIDEO index the member is on — an ordinal of the post, not a position
  // in the track, so hiding a slide never re-points it at a different video.
  const [active, setActive] = useState(0);
  // Indices whose STREAM mint answered 404 (the poster hook tracks its own).
  const [unplayable, setUnplayable] = useState<ReadonlySet<number>>(() => new Set());
  // The slide whose `play()` the browser declined — draws our play button.
  const [blocked, setBlocked] = useState<number | null>(null);

  // Keyed on `active`, not `current`: the poster hook's `missing` is what
  // derives `current`, so it cannot also be its input. The cost is one page turn
  // of prefetch lag right after a hidden slide — see `current` below.
  const { posters, missing } = useVideoPosters(postId, total, active);

  // The slides actually drawn. A 404 at an index hides that slide and the dots
  // recompute (rare: `videoCount` counts ready rows). Slide 0 is never hidden by
  // a poster mint — its poster came with the page — and if every slide were
  // somehow refused, slide 0 still draws rather than an empty track.
  const all = Array.from({ length: total }, (_, i) => i);
  const kept = all.filter((i) => !missing.has(i) && !unplayable.has(i));
  const visible = kept.length > 0 ? kept : [0];
  // The slide on screen: `active`, or — if `active` was just hidden — the next
  // one after it (else the last), resolved DURING render so the chip never
  // reads a position that no longer exists.
  const current = visible.includes(active)
    ? active
    : (visible.find((i) => i > active) ?? visible[visible.length - 1]);
  const pos = visible.indexOf(current);

  const playingIndex = playback?.playingIndex(postId) ?? null;
  const isPlaying = playingIndex !== null;

  const scrollToPos = useCallback((p: number, behavior: ScrollBehavior) => {
    const el = trackRef.current;
    // `scrollTo` is absent in jsdom; in a browser a smooth scroll settles a few
    // frames later. State is set by the callers first either way.
    if (!el || typeof el.scrollTo !== "function") return;
    el.scrollTo({ left: p * el.clientWidth, behavior });
  }, []);

  // A programmatic page turn in flight: where it is heading, and until when.
  // A smooth scroll fires `scroll` events as it travels, and the first half of
  // them still ROUND to the slide being left. Obeyed, they would flip `active`
  // back for a few frames — and if the next video's mint landed in that window
  // (an auto-advance, or a dot tap then a quick Play), the "swiped away" rule
  // below would stop the very video just started. So until the scroll arrives
  // (or a short grace expires, in case a finger interrupted it) those
  // intermediate positions are ignored.
  const pending = useRef<number | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(pendingTimer.current), []);

  /** The track position the scroll offset says is on screen, or null (no layout). */
  const settledPos = (): number | null => {
    const el = trackRef.current;
    const width = el?.clientWidth;
    // 0 in jsdom (no layout) — bail rather than clobber what a dot just set.
    if (!el || !width) return null;
    return Math.min(visible.length - 1, Math.max(0, Math.round(el.scrollLeft / width)));
  };

  const goTo = (p: number) => {
    const target = visible[p];
    if (target === undefined) return;
    setActive(target);
    // Already there: `scrollTo` will not move, so no event would ever clear a
    // guard — set none.
    if (p === pos) return;
    pending.current = p;
    clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => {
      // The grace ran out (a finger interrupted the scroll, and its final
      // event was one we ignored): trust where the track actually came to rest.
      pending.current = null;
      const at = settledPos();
      if (at !== null && visible[at] !== undefined) setActive(visible[at]);
    }, 800);
    scrollToPos(p, "smooth");
  };

  const onScroll = () => {
    const p = settledPos();
    if (p === null) return;
    if (pending.current !== null) {
      if (p !== pending.current) return;
      pending.current = null;
      clearTimeout(pendingTimer.current);
    }
    setActive(visible[p]);
  };

  // When a slide disappears the track's content shifts under its scroll offset;
  // re-seat it on the slide the member is on, instantly. Keyed on WHICH slides
  // exist only — never on a page turn, or it would fight a swipe in progress —
  // so the position is read through a ref.
  const posRef = useRef(pos);
  useEffect(() => {
    posRef.current = pos;
  });
  const layout = visible.join(",");
  useEffect(() => {
    scrollToPos(posRef.current, "auto");
  }, [layout, scrollToPos]);

  // Swiping away from a slide stops it — whether it is playing or its mint is
  // still in flight (which would otherwise mount a player off screen).
  const keepOnly = playback?.keepOnly;
  useEffect(() => {
    keepOnly?.(postId, current);
  }, [keepOnly, postId, current, playingIndex]);

  const startPlay = useCallback(
    (i: number) => {
      setBlocked(null);
      void playback?.play(postId, i, {
        onMissing: () => setUnplayable((prev) => (prev.has(i) ? prev : new Set(prev).add(i))),
      });
    },
    [playback, postId],
  );

  const onEnded = (i: number) => {
    const at = visible.indexOf(i);
    const next = visible[at + 1];
    // The last slide stops: the ended video stays on its final frame.
    if (next === undefined) return;
    goTo(at + 1);
    startPlay(next);
  };

  // The browser declined an unattended `play()`. Our button over the (loaded,
  // paused) video starts it INSIDE the tap, which every browser honours.
  const resume = (i: number) => {
    setBlocked(null);
    const video = trackRef.current?.querySelector<HTMLVideoElement>(`[data-video-index="${i}"] video`);
    void video?.play()?.catch(() => {});
  };

  const n = visible.length;

  return (
    <>
      <div
        ref={trackRef}
        className="photo-track"
        data-testid="video-track"
        onScroll={onScroll}
        // Focusable: once focused, the browser's own arrow-key scrolling walks
        // the slides and snap decides where they land (the photo carousel's rule).
        tabIndex={0}
        role="group"
        aria-roledescription="carousel"
        aria-label={`${n} videos`}
      >
        {visible.map((i, p) => {
          const poster = i === 0 ? firstPoster : (posters.get(i) ?? null);
          const url = playback?.urlFor(postId, i);
          const onScreen = i === current;
          return (
            <div className="photo-slide video-slide" data-testid="video-slide" data-video-index={i} key={i}>
              {url ? (
                <>
                  <HlsVideo
                    src={url}
                    poster={poster ?? undefined}
                    controls
                    playsInline
                    // Deliberately no autoplay attribute: HlsVideo issues its own
                    // explicit play() once the stream is attached.
                    onEnded={() => onEnded(i)}
                    // Started from the native control bar instead of our button:
                    // the blocked overlay must not sit over a playing video.
                    onPlay={() => setBlocked((b) => (b === i ? null : b))}
                    onFatalError={() => playback?.onFatal(postId, i)}
                    onPlayBlocked={() => setBlocked(i)}
                  />
                  {blocked === i && (
                    <button
                      className="media-play"
                      type="button"
                      aria-label={`Play video ${p + 1} of ${n}`}
                      onClick={() => resume(i)}
                    >
                      <Play />
                    </button>
                  )}
                </>
              ) : (
                <>
                  <PostMediaImage
                    postId={postId}
                    src={poster}
                    video
                    videoIndex={i}
                    placeholder={<div className="photo-slide-empty" data-testid="video-slide-empty" />}
                  />
                  <button
                    className="media-play"
                    type="button"
                    aria-label={`Play video ${p + 1} of ${n}`}
                    // Off-screen slides stay out of the tab order: a Tab would
                    // otherwise scroll the track to a slide nobody chose.
                    tabIndex={onScreen ? 0 : -1}
                    onClick={() => startPlay(i)}
                  >
                    <Play />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {/* The chip sits where the duration chip would; while a video plays its
          native control bar owns that corner, so the chip steps aside. */}
      {!isPlaying && <MediaVideoChip index={pos} total={n} />}

      {pos > 0 && (
        <button className="carousel-arrow prev" type="button" aria-label="Previous video" onClick={() => goTo(pos - 1)}>
          <Chevron dir="left" />
        </button>
      )}
      {pos < n - 1 && (
        <button className="carousel-arrow next" type="button" aria-label="Next video" onClick={() => goTo(pos + 1)}>
          <Chevron dir="right" />
        </button>
      )}

      {n > 1 && (
        <div className={isPlaying ? "photo-dots lifted" : "photo-dots"} data-testid="video-dots">
          {visible.map((i, p) => (
            <button
              key={i}
              type="button"
              className={p === pos ? "photo-dot active" : "photo-dot"}
              aria-label={`Go to video ${p + 1} of ${n}`}
              aria-current={p === pos}
              onClick={() => goTo(p)}
            />
          ))}
        </div>
      )}
    </>
  );
}
