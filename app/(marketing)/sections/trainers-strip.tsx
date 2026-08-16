/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */

import {
  TRAINERS,
  TRAINER_BIO_PLACEHOLDER,
  TRAINER_HORSES_PLACEHOLDER,
  type Trainer,
} from "./trainers.data";

/**
 * Section 8 — `section#stable-trainers.sec.tr-sec`, "Participating stables"
 * (ENG-588 / W2). MARKUP ONLY.
 *
 * ENG-588 decision 3 splits this section in half: the cards are here, every
 * behaviour is W3 (ENG-589). So this file has no auto-scroll marquee, no hover
 * pause, no arrows and no modal — W3 swaps the static row below for its
 * `<TrainerCarousel/>`, which is the single edit it declared against this file.
 *
 * TWO THINGS ARE DELIBERATE AND WORTH READING BEFORE "FIXING":
 *
 * 1. `.is-static` on `.tr-scroll`. That class is the mockup's OWN static state —
 *    its marquee adds it whenever one full card set is not wider than the strip,
 *    and it turns the track into a centred, wrapping row with no gradient mask.
 *    Without it, `.tr-scroll{overflow:hidden}` plus `.tr-track{width:max-content}`
 *    clips nineteen cards down to the three or four that fit, which fails the
 *    no-JS acceptance criterion outright — and the client reviews this page with
 *    scripting blocked. W3's `build()` removes the class the moment the marquee
 *    takes over, so this costs it nothing.
 *
 * 2. The `data-loc` / `data-horses` / `data-bio` attributes and the `.tr-over`
 *    overlay. The overlay is CSS-only (`:hover`/`:focus-visible`), so it works
 *    here. The data attributes are what W3's trainer modal reads off the clicked
 *    card; carrying them now is what lets W3 add the modal without reopening
 *    this file. `role="button"` + `tabIndex` likewise come from the mockup and
 *    are the affordance W3 activates.
 *
 * Guardrail #2: a card shows name, location and photograph. Nothing else about a
 * trainer is public, and `Trainer` in trainers.data.ts has no field that could
 * leak owner or contact detail.
 */

export type TrainersStripProps = {
  /** Defaults to the static list; W3 and the later CMS epic pass their own. */
  trainers?: Trainer[];
};

export default function TrainersStrip({ trainers = TRAINERS }: TrainersStripProps) {
  // The mockup's marquee reads this count off the section to decide static vs
  // loop, so it has to be the real length rather than a hard-coded 19.
  return (
    <section className="sec tr-sec" id="stable-trainers" data-trainer-count={trainers.length}>
      <div className="wrap">
        <div className="sec-head center rv" suppressHydrationWarning>
          <span className="eyebrow">Participating stables</span>
          <h2>The trainers in our stable.</h2>
          <p className="lead">
            stablepass. works with participating trainers who nominate selected horses for subscribers to follow and
            who share the stable stories behind them.
          </p>
        </div>
      </div>
      <div className="tr-scroll rv is-static" suppressHydrationWarning>
        <div className="tr-track">
          {trainers.map((trainer) => (
            <TrainerCard key={trainer.name} trainer={trainer} />
          ))}
        </div>
      </div>
      <div className="wrap">
        <p className="tr-fine">
          Photographs and locations are the real supplied trainer details. Bios and horse counts are placeholders
          pending the stables, and are editable from the admin portal.
        </p>
      </div>
    </section>
  );
}

/**
 * One card. `.tr-init` sits behind the photograph (both are `position:absolute;
 * inset:0`), so the initials disc is what shows if the image ever fails to load.
 */
function TrainerCard({ trainer }: { trainer: Trainer }) {
  return (
    <figure
      className="tr-card"
      tabIndex={0}
      role="button"
      data-loc={trainer.location}
      data-horses={TRAINER_HORSES_PLACEHOLDER}
      data-bio={TRAINER_BIO_PLACEHOLDER}
    >
      <span className="tr-init">{trainer.initials}</span>
      <img src={trainer.photo} alt={`${trainer.name}, ${trainer.location}`} />
      <figcaption className="tr-nm">{trainer.name}</figcaption>
      <div className="tr-over">
        <b>{trainer.name}</b>
        <span className="loc">{trainer.location}</span>
        <span className="hz">{TRAINER_HORSES_PLACEHOLDER}</span>
        <p className="bio">{TRAINER_BIO_PLACEHOLDER}</p>
        <span className="more">Read more</span>
      </div>
    </figure>
  );
}
