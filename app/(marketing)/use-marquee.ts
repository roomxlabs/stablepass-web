"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The trainer marquee driver (ENG-589 / W3).
 *
 * Ported from the third `<script>` block of the signed-off mockup
 * (`10-marketing-site/deploy/src/mockup.html`), which drives the strip on
 * `requestAnimationFrame` rather than a CSS keyframe. That is deliberate and it
 * is decision 1 of the ticket: the arrows nudge the SAME offset the drift is
 * using, so the two share one source of truth. A keyframe cannot be nudged.
 *
 * The decisions are split out as pure functions below the hook's imports so the
 * "same face twice" guard can be tested at its boundary without a layout engine
 * — jsdom has no layout, so a DOM test could never exercise it honestly.
 */

/* ── the pure decisions (no DOM; unit-tested directly) ───────────────── */

/**
 * Which of the three input modes the visitor is in. All three are in the source
 * and all three are required (ticket decision 3).
 *
 * `touch` wins over `reduced` because the source returns the touch driver
 * BEFORE it ever consults `prefers-reduced-motion` — on touch there is no rAF
 * to reduce, the strip is a native scroller either way.
 */
export type MarqueeMode = "touch" | "reduced" | "drift";

export type MarqueeEnvironment = {
  /** `(hover: none)` — no pointer that can hover, so nothing can pause a drift. */
  hoverNone: boolean;
  /** `(prefers-reduced-motion: reduce)`. */
  reducedMotion: boolean;
};

export function selectMode({ hoverNone, reducedMotion }: MarqueeEnvironment): MarqueeMode {
  if (hoverNone) return "touch";
  if (reducedMotion) return "reduced";
  return "drift";
}

export type CloneDecision = {
  /** How many REAL cards there are (duplicates excluded). */
  cardCount: number;
  /** Below this many cards the strip never loops, whatever the widths say. */
  min: number;
  /** One full set, including the trailing gap before it would repeat. */
  setWidth: number;
  /** The visible window. */
  stripWidth: number;
  /** The lead card plus its gap. */
  leadWidth: number;
};

/**
 * THE GUARD. The duplicate set must never be simultaneously visible, so the
 * strip only loops when one full set overhangs the window by at least a whole
 * card. Otherwise the clone would put the same face on screen twice at once,
 * which is the specific bug this comparison exists to prevent.
 *
 * Strictly greater-than, exactly as the source has it: at the boundary
 * (`setWidth === stripWidth + leadWidth`) the lead clone would sit flush at the
 * right edge, visible alongside its original. That is the failure, so the
 * boundary must fall on the static side.
 */
export function shouldClone({ cardCount, min, setWidth, stripWidth, leadWidth }: CloneDecision): boolean {
  return cardCount > min && setWidth > stripWidth + leadWidth;
}

/**
 * Keep the offset inside one set length, in BOTH directions.
 *
 * The backwards case is the one that matters: nudging -1 from 0 must land at
 * the end of the set, not at a negative translate that drags the track off to
 * the right and shows the empty space behind it.
 *
 * One correction is enough because every caller moves by less than a full set
 * (a drift step, or one card + gap).
 */
export function wrapOffset(offset: number, setWidth: number): number {
  if (!(setWidth > 0)) return 0;
  if (offset < 0) return offset + setWidth;
  if (offset >= setWidth) return offset - setWidth;
  return offset;
}

/* ── measurement ─────────────────────────────────────────────────────── */

/**
 * The gap is READ, never passed in (ticket decision 4): `.tr-track` is 22px at
 * desktop and 16px under 760px, so a hard-coded gap desynchronises the wrap
 * from the layout the moment a phone rotates.
 */
export function readGap(track: HTMLElement): number {
  const style = getComputedStyle(track);
  const parsed = Number.parseFloat(style.columnGap || style.gap);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export type MarqueeMeasurement = {
  gap: number;
  stripWidth: number;
  setWidth: number;
  leadWidth: number;
  cardCount: number;
};

/**
 * Measure one set, ignoring any duplicates already on screen.
 *
 * The source uses `track.scrollWidth + gap`. We sum the non-duplicate children
 * instead, which is the same number (`Σw + (n-1)·gap + gap === Σw + n·gap`) but
 * survives two situations the source never met:
 *
 *   1. A resize rebuild happens with the clones still in the DOM, where
 *      `scrollWidth` would report TWO sets and double `setWidth`. The source
 *      dodged this by removing its clones first; React renders them from state,
 *      so they are still there when we measure.
 *   2. The first measurement runs while `.is-static` is applied — see the hook
 *      below — and that class sets `flex-wrap:wrap`, under which `scrollWidth`
 *      describes a wrapped block and not a row at all. Summing fixed-width
 *      cards is unaffected by how they wrap.
 */
export function measureMarquee(scroll: HTMLElement, track: HTMLElement): MarqueeMeasurement {
  const gap = readGap(track);
  const cards = Array.from(track.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && !child.hasAttribute("data-dup"),
  );
  const setWidth = cards.reduce((total, card) => total + card.offsetWidth, 0) + gap * cards.length;
  return {
    gap,
    stripWidth: scroll.clientWidth,
    setWidth,
    leadWidth: (cards[0]?.offsetWidth ?? 0) + gap,
    cardCount: cards.length,
  };
}

/* ── the hook ────────────────────────────────────────────────────────── */

/** Ticket decision 4. */
const RESIZE_DEBOUNCE_MS = 150;
/** The source's arrow easing, verbatim. */
const NUDGE_TRANSITION = "transform .45s cubic-bezier(.3,.9,.3,1)";
const NUDGE_TRANSITION_MS = 460;

export type UseMarqueeOptions = {
  /** Pixels per frame. The mockup passes .26 for the trainer strip. */
  speed: number;
  /** The mockup passes 4 for the trainer strip. */
  min: number;
};

export type UseMarquee = {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  trackRef: React.RefObject<HTMLDivElement | null>;
  /** Render `.is-static` on the scroller while this is true. */
  isStatic: boolean;
  /** Render the aria-hidden duplicate set while this is true. */
  duplicated: boolean;
  nudge: (direction: -1 | 1) => void;
};

export function useMarquee({ speed, min }: UseMarqueeOptions): UseMarquee {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  /**
   * BOTH of these start in the server-rendered state and are only moved by the
   * mount effect below.
   *
   * `isStatic` starts TRUE because W2 server-renders `.is-static` deliberately:
   * without it `.tr-scroll{overflow:hidden}` clips about thirteen of the
   * nineteen cards when scripting is off, and the client reviews this page with
   * JS blocked. The first client render therefore has to agree with that markup
   * or React reports a hydration mismatch on every load — which is why this is
   * state rather than a `classList` mutation.
   */
  const [isStatic, setIsStatic] = useState(true);
  const [duplicated, setDuplicated] = useState(false);

  const modeRef = useRef<MarqueeMode>("drift");
  const offsetRef = useRef(0);
  const setWidthRef = useRef(0);
  const gapRef = useRef(0);
  const pausedRef = useRef(false);
  const liveRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const apply = useCallback(() => {
    const track = trackRef.current;
    if (track) track.style.transform = `translateX(${-offsetRef.current}px)`;
  }, []);

  const cancel = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  /** Measure, decide, and publish the decision as state for React to render. */
  const build = useCallback(() => {
    const scroll = scrollRef.current;
    const track = trackRef.current;
    if (!scroll || !track) return false;

    track.style.transform = "";
    const measurement = measureMarquee(scroll, track);
    gapRef.current = measurement.gap;
    setWidthRef.current = measurement.setWidth;

    const live = shouldClone({ ...measurement, min });
    liveRef.current = live;
    setDuplicated(live);
    setIsStatic(!live);
    return live;
  }, [min]);

  useEffect(() => {
    const scroll = scrollRef.current;
    const track = trackRef.current;
    if (!scroll || !track) return;

    const mode = selectMode({
      hoverNone: window.matchMedia("(hover: none)").matches,
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    });
    modeRef.current = mode;

    if (mode === "touch") {
      /**
       * No rAF at all, no clones, no resize listener — the source returns a
       * bare `scrollBy` nudger here and never calls `build()`.
       *
       * Dropping `.is-static` is the one place this deviates from the source's
       * CODE in order to match its BEHAVIOUR. The mockup's markup never carries
       * the class, so on touch its strip is the `@media (hover:none)` native
       * scroller (`overflow-x:auto; scroll-snap-type:x mandatory`). W2 added the
       * class for the no-JS row, so leaving it on would wrap the track into a
       * block and there would be nothing to swipe.
       */
      liveRef.current = false;
      /* eslint-disable-next-line react-hooks/set-state-in-effect -- this IS the
         sanctioned case: the input mode can only be read from `matchMedia`
         after mount, so the component renders the server's static row first and
         adapts once. There is no render-time source for it (touching
         `matchMedia` during render would break SSR), and the same one-shot
         measure-then-adapt happens in `build()` below. */
      setDuplicated(false);
      setIsStatic(false);
      return;
    }

    build();

    const onEnter = () => {
      pausedRef.current = true;
    };
    const onLeave = () => {
      pausedRef.current = false;
    };
    track.addEventListener("mouseenter", onEnter);
    track.addEventListener("mouseleave", onLeave);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Cancel first, reset the offset, then re-decide: the card width, the
        // gap AND the clone decision can all differ on the other side of a
        // breakpoint, so nothing measured before the resize is still true.
        cancel();
        offsetRef.current = 0;
        build();
        apply();
      }, RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener("resize", onResize);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      track.removeEventListener("mouseenter", onEnter);
      track.removeEventListener("mouseleave", onLeave);
    };
  }, [build, apply, cancel]);

  /**
   * The drift itself, started only once the duplicates are actually rendered —
   * translating a single set would drag its tail into open space.
   *
   * `reduced` never gets here: it still clones and still nudges (the arrows are
   * a deliberate action, not motion the visitor did not ask for), it simply has
   * no loop. That is the source's behaviour and the ticket's acceptance
   * criterion both.
   */
  useEffect(() => {
    if (modeRef.current !== "drift" || !duplicated) return;

    const step = () => {
      if (!pausedRef.current) {
        offsetRef.current = wrapOffset(offsetRef.current + speed, setWidthRef.current);
        apply();
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    return cancel;
  }, [duplicated, speed, apply, cancel]);

  const nudge = useCallback(
    (direction: -1 | 1) => {
      const scroll = scrollRef.current;
      const track = trackRef.current;
      if (!scroll || !track) return;

      const lead = track.children[0];
      const leadWidth = lead instanceof HTMLElement ? lead.offsetWidth : 0;

      if (modeRef.current === "touch") {
        // Native scroll, so the arrows move the scroller and not a transform.
        scroll.scrollBy({ left: direction * (leadWidth + readGap(track)), behavior: "smooth" });
        return;
      }

      // A static strip has nowhere to go: every card is already on screen.
      if (!liveRef.current) return;

      offsetRef.current = wrapOffset(offsetRef.current + direction * (leadWidth + gapRef.current), setWidthRef.current);
      track.style.transition = NUDGE_TRANSITION;
      apply();
      // Hand the offset back to the drift once the eased nudge has landed.
      window.setTimeout(() => {
        if (trackRef.current) trackRef.current.style.transition = "";
      }, NUDGE_TRANSITION_MS);
    },
    [apply],
  );

  return { scrollRef, trackRef, isStatic, duplicated, nudge };
}
