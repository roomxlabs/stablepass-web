/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */
"use client";

import { useMarquee } from "./use-marquee";

/**
 * The eight app screens in `#mem-apps`, their drift and their arrows.
 *
 * W2 (ENG-588) shipped the `[data-ma]` arrows INERT, on the stated contract that
 * W3 (ENG-589) would bind them with an event delegate. W3 built the driver but
 * only ever wired the trainer strip, so the arrows went to production dead: the
 * row sits under `.ma-scroll{overflow:hidden}` with nothing translating it, and
 * a visitor on a desktop can reach neither the last three screens nor the
 * controls. This is the missing half of that contract.
 *
 * Same driver as the trainer strip rather than a second mechanism — the mockup
 * calls one `marquee()` for both rows, so they share the clone guard, the wrap
 * arithmetic and the arrow easing. See `trainer-carousel.tsx`, which this
 * deliberately mirrors.
 */

/** `marquee(maScroll,maTrack,{speed:.32,gap:44,min:3})` in the source. */
const APP_SCREEN_SPEED = 0.32;
const APP_SCREEN_MIN = 3;

export type AppScreen = {
  src: string;
  alt: string;
  caption: string;
};

export type AppScreensCarouselProps = {
  screens: AppScreen[];
};

export default function AppScreensCarousel({ screens }: AppScreensCarouselProps) {
  const { scrollRef, trackRef, isStatic, duplicated, nudge } = useMarquee({
    speed: APP_SCREEN_SPEED,
    min: APP_SCREEN_MIN,
  });

  return (
    <>
      <div ref={scrollRef} className={`ma-scroll${isStatic ? " is-static" : ""}`} suppressHydrationWarning>
        <div ref={trackRef} className="ma-row">
          {screens.map((screen) => (
            <AppScreenCard key={screen.caption} screen={screen} />
          ))}
          {/* The duplicate set that makes the loop seamless. `data-dup` is not
              decoration: measureMarquee filters on it to size ONE set. */}
          {duplicated &&
            screens.map((screen) => (
              <AppScreenCard key={`dup-${screen.caption}`} screen={screen} duplicate />
            ))}
        </div>
      </div>

      <div className="ma-ctrl">
        <button type="button" data-ma="-1" aria-label="Previous screen" onClick={() => nudge(-1)}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M15 5 8 12l7 7" />
          </svg>
        </button>
        <button type="button" data-ma="1" aria-label="Next screen" onClick={() => nudge(1)}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>
      </div>
    </>
  );
}

type AppScreenCardProps = {
  screen: AppScreen;
  /** One of the seamless-loop copies rather than a real screen. */
  duplicate?: boolean;
};

/**
 * One phone. A duplicate is `aria-hidden` and carries `data-dup="1"`, so the
 * loop does not make a screen reader announce all eight screens twice. Unlike a
 * trainer card there is nothing to click here, so there is no tab order to keep
 * a duplicate out of.
 */
function AppScreenCard({ screen, duplicate = false }: AppScreenCardProps) {
  return (
    <figure className="ma" {...(duplicate ? { "aria-hidden": true, "data-dup": "1" } : {})}>
      <div className="phone">
        <div className="ph-view">
          <span className="ph-island" />
          <img className="shot" src={screen.src} alt={duplicate ? "" : screen.alt} />
          <span className="ph-home" />
        </div>
      </div>
      <figcaption>{screen.caption}</figcaption>
    </figure>
  );
}
