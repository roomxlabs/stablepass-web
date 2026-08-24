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
import { useCallback, useRef, useState } from "react";
import type { PostPhoto } from "./types";

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
  photos: PostPhoto[];
  /**
   * Rendered into each slide's `alt`. Empty by default and that is deliberate:
   * the card's existing single `<img>` is `alt=""` because the horse name,
   * byline and caption immediately below already name the subject — the photo is
   * illustrative, so an invented per-slide description would be noise, not access.
   */
  alt?: string;
}

/**
 * The paging track + dots. Mounted INSIDE `.post-media-web`, alongside the chip,
 * the watermark overlay and the Follow pill, all of which keep their corners.
 */
export function PhotoCarousel({ photos, alt = "" }: PhotoCarouselProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);
  const total = photos.length;

  // A post whose photo count shrinks (a re-fetch after an admin edit) must not
  // leave the counter reading "3/2". Clamped DURING RENDER rather than corrected
  // afterwards in an effect: an effect would render the impossible value once
  // first, and then re-render to fix it.
  const active = Math.min(index, Math.max(0, total - 1));

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
        {photos.map((photo, i) => (
          <div className="photo-slide" data-testid="photo-slide" key={`${photo.sort}-${i}`}>
            {photo.url ? (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary signed Storage URL, cover-fit
              <img src={photo.url} alt={alt} />
            ) : (
              // This ONE photo failed to sign. It draws the media ground exactly
              // as a poster-less card does, and its siblings still render — a
              // dead slide must never take the whole post down.
              <div className="photo-slide-empty" data-testid="photo-slide-empty" />
            )}
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
        {photos.map((photo, i) => (
          <button
            key={`${photo.sort}-${i}`}
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
