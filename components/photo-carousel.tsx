"use client";

// photo-carousel — the multi-photo media layer for a post (round 6 / ENG-762),
// the web half of mobile's R16 (ENG-757). It fills the card's EXISTING
// `.post-media-web` box rather than drawing its own: one aspect box per post, so
// the card never changes height between slides. Note the slides are `object-fit:
// cover` (the stylesheet's rule for any image in that box), so a photo whose
// ratio differs from the post's is CROPPED to fill, not letterboxed.
//
// NO LIBRARY, by decision on the ticket. Paging is CSS `scroll-snap`, which
// means the core affordance — swipe on touch, drag/scroll on trackpad, the
// native scrollbar, and arrow keys once the track has focus — costs zero JS.
// JS adds the dots as clickable shortcuts and the `n/m` counter.
//
// Without JS the photos are still all reachable by scrolling, but the indicator
// does not follow: the dots render as inert buttons and the chip stays on "1/n".
// So no-JS degrades to a WRONG indicator, not to no indicator. Acceptable here
// because this is the authenticated member app, which needs JS regardless; it
// is the marketing site that has the JS-blocked requirement.
//
// ---------------------------------------------------------------------------
// ENG-815 — WHERE THE SLIDES COME FROM
//
// The geometry above is unchanged. What changed underneath it is the source of
// the pixels: ENG-762 handed this component a fully-resolved `PostPhoto[]` that
// a client island had read out of `post_media` and signed itself. ENG-800
// revoked that bucket, so this now takes a POST ID and a SLIDE COUNT and mints
// each slide through the BFF, addressed by `{ postId, slideIndex }`.
//
// The count is what makes that work without a flash of the wrong UI: it rides in
// on the same batch response as slide 0, so the dots and the `n/m` chip are
// CORRECT ON FIRST PAINT, before a single extra slide has been minted (ENG-809
// decision 3). Deriving the dots from "how many slides have arrived" instead
// would grow them one at a time as the mints landed.
import { useCallback, useRef, useState } from "react";
import { clampSlideCount, usePostSlides } from "@/lib/post-media";
import { PostMediaImage } from "./post-media-image";

/**
 * The still-image chip, lifted out of `post-card` (ENG-761 item 3) so the single-
 * and multi-photo cards draw the SAME element instead of two that drift apart.
 *
 * It is one affordance with two states, not two chips: a single photo says what
 * it IS with the glyph, and a multi-photo post says the same thing plus WHERE
 * YOU ARE in it. Same corner, same scrim, same pill radius as `.media-duration`
 * either way — that corner is where this card has always declared its media.
 */
export const PhotoGlyph = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="m21 16-5-5L5 19" />
  </svg>
);

export interface MediaPhotoChipProps {
  /** 0-based index of the visible photo. Ignored when `total` is 1. */
  index?: number;
  /** How many photos the post carries. 1 (the default) draws the glyph alone. */
  total?: number;
}

export function MediaPhotoChip({ index = 0, total = 1 }: MediaPhotoChipProps) {
  const multi = total > 1;
  // The accessible name carries the position too. A screen reader on a
  // multi-photo card should hear "Photo 2 of 3", not a bare "Photo" that is
  // identical on every slide.
  const label = multi ? `Photo ${index + 1} of ${total}` : "Photo";
  return (
    <div
      className={multi ? "media-photo-chip counted" : "media-photo-chip"}
      data-testid="media-photo-chip"
      role="img"
      aria-label={label}
    >
      <PhotoGlyph />
      {multi && (
        // aria-hidden: the wrapper's aria-label already says "Photo 2 of 3", so
        // announcing the bare "2/3" again would double it up.
        <span className="media-photo-count" data-testid="media-photo-count" aria-hidden="true">
          {index + 1}/{total}
        </span>
      )}
    </div>
  );
}

export interface PhotoCarouselProps {
  /**
   * The post these slides belong to. It is the ONLY handle the client has on
   * them: a slide is requested as `{ postId, slideIndex }` and the server
   * resolves the storage path (ENG-809 decision 2). Nothing here builds a path.
   */
  postId: string;
  /**
   * `slideCount` from the page's batch mint. Drives the dots and the `n/m` chip
   * BEFORE any slide past 0 exists, which is the whole reason the be returns it
   * in the batch rather than making the client count what it has received.
   */
  slideCount: number;
  /** Slide 0's minted url — already in hand from the same batch response. */
  firstUrl?: string | null;
}

/**
 * The paging track + dots. Mounted INSIDE `.post-media-web`, alongside the chip,
 * the watermark overlay and the Follow pill, all of which keep their corners.
 */
export function PhotoCarousel({ postId, slideCount, firstUrl = null }: PhotoCarouselProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);
  // The authority on how many slides to draw. `clampSlideCount` also floors it
  // at 1, so a nonsense count off the wire degrades to a one-slide carousel
  // rather than an empty track.
  const total = clampSlideCount(slideCount);

  // A post whose photo count shrinks (a re-fetch after an admin edit) must not
  // leave the counter reading "3/2". Clamped DURING RENDER rather than corrected
  // afterwards in an effect: an effect would render the impossible value once
  // first, and then re-render to fix it.
  const active = Math.min(index, Math.max(0, total - 1));

  // Mints the active slide and the one after it, once each (ENG-809 decision 1).
  // Slide 0 is never in here — it arrived in the batch as `firstUrl`.
  const minted = usePostSlides(postId, total, active);

  const onScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    // `clientWidth` is 0 in jsdom (no layout), which would make every slide
    // index 0/NaN. Bail rather than clobbering an index the dots just set —
    // paging itself is covered by the dot-click path in the unit suite, and by
    // a real browser in Playwright.
    const width = el.clientWidth;
    if (!width) return;
    const next = Math.round(el.scrollLeft / width);
    setIndex(Math.min(total - 1, Math.max(0, next)));
  }, [total]);

  const goTo = useCallback((i: number) => {
    const el = trackRef.current;
    // Set state FIRST and unconditionally: `scrollTo` is not implemented in
    // jsdom, and in a real browser the smooth scroll settles a few frames later.
    // Either way the dot the user just pressed should light up now.
    setIndex(i);
    if (!el || typeof el.scrollTo !== "function") return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
  }, []);

  // `slideCount` is the be's HIGHEST ORDINAL + 1, not a row count, so a
  // non-contiguous `{0, 2}` legitimately reports 3 and index 1 mints to nothing.
  // That slide draws the media ground and its siblings still render — a gap, not
  // the lost photo a row count would have produced.
  const slides = Array.from({ length: total }, (_, i) => (i === 0 ? firstUrl : minted.get(i) ?? null));

  return (
    <>
      <div
        ref={trackRef}
        className="photo-track"
        data-testid="photo-track"
        onScroll={onScroll}
        // Focusable so the track can be reached and driven by the keyboard: once
        // focused, the browser's own arrow-key scrolling walks the slides and
        // snap decides where it lands. That is why there is no bespoke keydown
        // handler here — re-implementing it would only fight the native one.
        tabIndex={0}
        role="group"
        aria-roledescription="carousel"
        aria-label={`${total} photos`}
      >
        {slides.map((url, i) => (
          <div className="photo-slide" data-testid="photo-slide" key={i}>
            {/* PostMediaImage, not a bare <img>, so EVERY slide keeps ENG-813's
                one-retry recovery — and re-mints by its own index rather than
                pulling slide 0's url from the batch. A slide with no url yet
                (not minted, or refused) renders the same empty ground a
                poster-less card draws; "not yet" and "never" are deliberately
                indistinguishable on screen, because telling them apart is how a
                draft's existence would leak.

                `alt` is empty on every slide, exactly as the card's single
                <img> is: the horse name, byline and caption directly below
                already name the subject, so an invented per-slide description
                would be noise rather than access. */}
            <PostMediaImage
              postId={postId}
              src={url}
              slideIndex={i}
              placeholder={<div className="photo-slide-empty" data-testid="photo-slide-empty" />}
            />
          </div>
        ))}
      </div>

      {/* The chip is rendered HERE rather than by the card because the index it
          counts lives here. It is the same `MediaPhotoChip` the single-photo
          card draws, in the same corner — one affordance, two states. It also
          keeps the card's existing paint order (chip under the watermark
          overlay, Follow pill on top) exactly as ENG-761 left it. */}
      <MediaPhotoChip index={active} total={total} />

      <div className="photo-dots" data-testid="photo-dots">
        {slides.map((_, i) => (
          <button
            key={i}
            type="button"
            className={i === active ? "photo-dot active" : "photo-dot"}
            aria-label={`Go to photo ${i + 1} of ${total}`}
            aria-current={i === active}
            onClick={() => goTo(i)}
          />
        ))}
      </div>
    </>
  );
}
