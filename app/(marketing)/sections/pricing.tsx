/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */

/**
 * Section 6 — `section#subscription.sec.price-sec`, the price card
 * (ENG-588 / W2).
 *
 * Nav target for "Subscription", and where both hero CTAs and the nav CTA land.
 *
 * COPY NOTE, deliberate and signed off: this card says "$19 per month" and
 * "Cancel anytime", which does not match the non-renewing 30-day pass ENG-567
 * shipped. ENG-588's resolved open question is explicit — ship it verbatim, the
 * mismatch is a client conversation recorded on the epic, not a bug to fix here.
 *
 * The two CTAs both point at `#top` in the mockup because the concept had no
 * checkout behind it. W5 repoints them; leaving them as the mockup has them keeps
 * this ticket's diff to markup.
 */

const INCLUDED = [
  "Access to participating stable updates",
  "Behind-the-scenes photos & videos",
  "Horse progress updates",
  "Race previews & results",
  "Stable insights",
  "Subscription-only racing content",
  "Simple monthly billing",
  "Cancel anytime",
];

export default function Pricing() {
  return (
    <section className="sec price-sec" id="subscription">
      <div className="price-oval" aria-hidden="true" />
      <div className="wrap">
        <div className="sec-head center rv" suppressHydrationWarning>
          <span className="eyebrow">Subscription</span>
          <h2>One simple subscription.</h2>
          <p className="lead">
            $9/month for your first 6 months, then $19/month for behind-the-scenes racing content from participating
            stables. Simple monthly billing. Cancel anytime.
          </p>
        </div>
        <div className="price-card rv" suppressHydrationWarning>
          <div className="pc-top">
            <span>STABLEPASS. SUBSCRIBER</span>
            <span style={{ color: "#EDD9A8", fontWeight: 700 }}>INTRO OFFER</span>
          </div>
          <div className="price-num">
            $9<small>/month for your first 6 months, then $19</small>
          </div>
          <ul className="price-list">
            {INCLUDED.map((item) => (
              <li key={item}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
                {item}
              </li>
            ))}
          </ul>
          <a className="btn cta-trial" href="/start">
            Get the $9/month offer
          </a>
          <a className="btn cta-join" href="/start">
            Start Your Subscription
          </a>
          <p className="price-fine">
            $9/month for your first 6 months, then $19/month. stablepass. provides content access and racing
            experiences only.
          </p>
          <img className="pc-mark" src="/marketing/ec7c405b.png" alt="" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
