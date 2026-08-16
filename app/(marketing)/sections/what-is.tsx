/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */

/**
 * Section 2 — `section.sec`, the "What is stablepass." duo (ENG-588 / W2).
 *
 * Unnamed on purpose: the mockup gives it no id and the nav never links to it.
 * `#img-track` on the photograph is carried over as-is; nothing in the ported
 * CSS or JS targets it, but it is part of the frozen markup.
 */
export default function WhatIs() {
  return (
    <section className="sec">
      <div className="wrap duo rv" suppressHydrationWarning>
        <div className="duo-media">
          <img
            src="/marketing/edf7078d.jpg"
            alt="A racehorse looks out from its stall on a quiet morning"
            id="img-track"
            width={900}
            height={600}
          />
        </div>
        <div className="duo-copy">
          <span className="eyebrow">What is stablepass.</span>
          <h2>A thoroughbred racing experience subscription.</h2>
          <p>
            stablepass. is a subscription platform for people who love the horse, the excitement of thoroughbred
            racing and want to experience the day-to-day stories of stable life which the average race fan often
            would never get to experience.
          </p>
          <p>
            stablepass. gives racing fans access to behind-the-scenes content from participating stables. Follow
            selected horses, see stable updates, watch race day build up and enjoy the stories that happen before and
            after the race.
          </p>
          <p className="accent">It is racing entertainment made simple.</p>
        </div>
      </div>
    </section>
  );
}
