import TrainerCarousel from "../trainer-carousel";
import { TRAINERS, type Trainer } from "./trainers.data";

/**
 * Section 8 — `section#stable-trainers.sec.tr-sec`, "Participating stables"
 * (ENG-588 / W2, made interactive by ENG-589 / W3).
 *
 * ENG-588 decision 3 split this section in half: the section shell is here, and
 * every behaviour is W3's. W3's single declared edit against this file has now
 * landed — the static row became `<TrainerCarousel/>`, which owns `.tr-scroll`,
 * the cards, the duplicate set, the `.tr-ctrl` arrows and `#tr-modal`. The card
 * markup moved with it because the component that measures the cards has to be
 * the component that renders them.
 *
 * WHAT DID NOT CHANGE, AND WHY IT MATTERS:
 *
 * 1. `.is-static` is still what the SERVER renders — the carousel initialises
 *    its state to it. That class is the mockup's own static state, and it turns
 *    the track into a centred, wrapping row. Without it `.tr-scroll{overflow:
 *    hidden}` plus `.tr-track{width:max-content}` clips nineteen cards down to
 *    the three or four that fit, which fails the no-JS acceptance criterion —
 *    and the client reviews this page with scripting blocked. The marquee drops
 *    the class only once it has measured and decided to loop.
 *
 * 2. `data-trainer-count` (W3 decision 8). The count is the real list length,
 *    which is how the strip decides static vs marquee when the list becomes
 *    admin-driven in the CMS epic.
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
  // No participating stables means no section at all, rather than a heading
  // over an empty strip. Not reachable from the static list, but the list
  // becomes admin-driven in the CMS epic.
  if (trainers.length === 0) return null;

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
      <TrainerCarousel trainers={trainers} />
      <div className="wrap">
        <p className="tr-fine">
          Photographs and locations are the real supplied trainer details. Bios and horse counts are placeholders
          pending the stables, and are editable from the admin portal.
        </p>
      </div>
    </section>
  );
}

