/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */
"use client";

import { useState, type KeyboardEvent } from "react";

import TrainerModal from "./modals/trainer-modal";
import { type Trainer } from "./sections/trainers.data";
import { useMarquee } from "./use-marquee";

/**
 * The trainer marquee, its arrows and its modal (ENG-589 / W3).
 *
 * Replaces the static row W2 left in `sections/trainers-strip.tsx`. The section
 * shell — heading, `data-trainer-count`, the fine print — stays there; this owns
 * everything from `.tr-scroll` down, because the cards, the duplicate set and
 * the arrows all have to be rendered by the same component that measures them.
 *
 * Server-rendered like any client component, so with scripting off the visitor
 * still gets all nineteen cards in the `.is-static` wrapped row W2 ships. The
 * marquee only takes over once the mount effect has measured.
 */

/** `marquee(scroll, track, {speed:.26, gap:22, min:4})` in the source. */
const TRAINER_SPEED = 0.26;
const TRAINER_MIN = 4;

export type TrainerCarouselProps = {
  trainers: Trainer[];
};

export default function TrainerCarousel({ trainers }: TrainerCarouselProps) {
  const { scrollRef, trackRef, isStatic, duplicated, nudge } = useMarquee({
    speed: TRAINER_SPEED,
    min: TRAINER_MIN,
  });
  const [active, setActive] = useState<Trainer | null>(null);

  return (
    <>
      <div
        ref={scrollRef}
        className={`tr-scroll rv${isStatic ? " is-static" : ""}`}
        suppressHydrationWarning
      >
        <div ref={trackRef} className="tr-track">
          {trainers.map((trainer) => (
            <TrainerCard key={trainer.id} trainer={trainer} onOpen={setActive} />
          ))}
          {/**
           * The duplicate set. Rendered from state rather than `cloneNode`d
           * into the DOM behind React's back, but carrying exactly the
           * attributes the source puts on its clones.
           */}
          {duplicated &&
            trainers.map((trainer) => (
              <TrainerCard key={`dup-${trainer.id}`} trainer={trainer} onOpen={setActive} duplicate />
            ))}
        </div>
      </div>

      <div className="tr-ctrl">
        <button type="button" data-tr="-1" aria-label="Previous trainer" onClick={() => nudge(-1)}>
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
        <button type="button" data-tr="1" aria-label="Next trainer" onClick={() => nudge(1)}>
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

      <TrainerModal trainer={active} onClose={() => setActive(null)} />
    </>
  );
}

type TrainerCardProps = {
  trainer: Trainer;
  onOpen: (trainer: Trainer) => void;
  /** One of the seamless-loop copies rather than a real card. */
  duplicate?: boolean;
};

/**
 * One card. `.tr-init` sits behind the photograph (both `position:absolute;
 * inset:0`), so the initials disc shows if the image fails to load.
 *
 * A duplicate is `aria-hidden="true"`, carries `data-dup="1"` and has NO
 * `tabIndex` or `role` — without that the loop puts all nineteen trainers in
 * the tab order twice and a screen reader announces each of them twice.
 *
 * It stays clickable, though: mid-drift a duplicate is a real card as far as
 * the visitor is concerned, and the mockup opens the modal from one because its
 * delegate matches `.tr-card` on the clone too. Silently ignoring the click
 * would be the regression, not the fidelity.
 */
function TrainerCard({ trainer, onOpen, duplicate = false }: TrainerCardProps) {
  const open = () => onOpen(trainer);

  // The source's Enter/Space handler, scoped to the card that owns it.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  };

  const interaction = duplicate
    ? { "aria-hidden": true, "data-dup": "1" }
    : { tabIndex: 0, role: "button", onKeyDown };

  return (
    <figure
      className="tr-card"
      onClick={open}
      data-loc={trainer.location}
      data-horses={trainer.horses}
      data-bio={trainer.bio}
      {...interaction}
    >
      {/*
        `.tr-init` and the photograph are BOTH `position:absolute; inset:0` in the
        mockup, the disc first, so the photograph covers it when there is one.
        ENG-730 makes the roster live, and `marketing_photo_path` is null until an
        admin copies a photo across (ENG-766 / W8) — so at launch the usual card
        has NO `<img>` at all and the disc is simply what shows. Rendering an
        `<img>` with an empty src instead would fire a request for the page URL
        and paint a broken-image glyph over the disc.
      */}
      <span className="tr-init">{trainer.initials}</span>
      {trainer.photo && (
        <img src={trainer.photo} alt={trainer.location ? `${trainer.name}, ${trainer.location}` : trainer.name} />
      )}
      <figcaption className="tr-nm">{trainer.name}</figcaption>
      <div className="tr-over">
        <b>{trainer.name}</b>
        {/*
          Live data means any of these three can be absent, where the hardcoded
          roster always had all of them. An element is omitted rather than
          rendered empty: an empty `.hz` still draws its uppercase mono letter-
          spacing and margin, and an empty `.bio` still reserves three lines
          under the mask, both of which read as a rendering fault on the card.
          No placeholder copy is substituted — ENG-730 deletes the "Horses to be
          confirmed" / "Trainer bio to come from the stable." strings outright.
        */}
        {trainer.location && <span className="loc">{trainer.location}</span>}
        {trainer.horses && <span className="hz">{trainer.horses}</span>}
        {trainer.bio && <p className="bio">{trainer.bio}</p>}
        <span className="more">Read more</span>
      </div>
    </figure>
  );
}
