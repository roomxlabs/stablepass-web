import TrainerCarousel from "../trainer-carousel";
import { type Trainer } from "./trainers.data";

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
 *    which is how the strip decides static vs marquee. It was pinned at 19 while
 *    the roster was hardcoded; ENG-730 makes it whatever the view serves.
 *
 * Guardrail #2: a card shows name, location, photograph, the stable's bio and
 * its horse names. Nothing else about a trainer is public — `Trainer` in
 * trainers.data.ts has no field that could leak owner or contact detail, and its
 * two new fields come from the marketing-safe view only.
 */

export type TrainersStripProps = {
  /**
   * The published roster, read live from `public_trainer` (ENG-730).
   *
   * There is no default list any more. It defaults to EMPTY rather than to a
   * placeholder roster, so the failure direction is "no strip" — never nineteen
   * fictional stables on the client's site.
   */
  trainers?: Trainer[];
};

export default function TrainersStrip({ trainers = [] }: TrainersStripProps) {
  // No participating stables means no section at all, rather than a heading over
  // an empty strip. This is now the REAL launch state, not a hypothetical:
  // `trainer.marketing_visible` defaults to false, so the strip stays absent
  // until an admin opts stables in (ENG-766 / W8).
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
      {/* ENG-600: the `.tr-fine` line was removed. It read "Photographs and locations
          are the real supplied trainer details. Bios and horse counts are placeholders
          pending the stables, and are editable from the admin portal." That is copy
          written FOR Justin during review, sitting on the public page, and it disclosed
          the admin portal to subscribers. The bios and horse counts it describes are
          still deliberate placeholders and must stay that way until the stables supply
          real copy — see ENG-600 section B. */}
    </section>
  );
}

