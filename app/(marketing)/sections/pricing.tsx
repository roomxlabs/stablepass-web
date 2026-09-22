/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */

/**
 * Section 6 — `section#subscription.sec.price-sec`, the price card
 * (ENG-588 / W2).
 *
 * Nav target for "Subscription", and where both hero CTAs and the nav CTA land.
 *
 * COPY NOTE, rewritten by ENG-1324 (Pricing v2). This card used to carry the
 * signed-off mockup's "$19 per month" and the "$9/month for your first 6 months"
 * launch offer. Both are retired: the price is A$9.99 per month after a 30-day
 * free trial, identical on the website, the App Store and Google Play (epic
 * ENG-1321, locked decisions 1, 2 and 5).
 *
 * The mockup in the design tree still says $19, so this file now deliberately
 * DIVERGES from it. That divergence is not silent — every replaced run is listed
 * in PRICING_V2_COPY in `test/marketing-home.test.tsx`, which is what keeps the
 * copy freeze meaningful instead of just switched off.
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
            30 days free, then A$9.99 per month for behind-the-scenes racing content from participating stables.
            Simple monthly billing. Cancel anytime. No lock-in contract.
          </p>
        </div>
        <div className="price-card rv" suppressHydrationWarning>
          <div className="pc-top">
            <span>STABLEPASS. SUBSCRIBER</span>
            <span style={{ color: "#EDD9A8", fontWeight: 700 }}>30 DAYS FREE</span>
          </div>
          {/* The standing price leads; the trial sits prominently under it, in the
              slot the retired launch offer used to occupy. */}
          <div className="price-num">
            A$9.99<small>/month</small>
          </div>
          <p className="price-launch">Start with 30 days free.</p>
          <p className="price-intro">Then A$9.99 per month. Cancel anytime. No lock-in contract.</p>
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
            Start your 30 days free
          </a>
          <a className="btn cta-join" href="/start">
            Start Your Subscription
          </a>
          <p className="price-fine">
            The same A$9.99 per month on the website, the App Store and Google Play. stablepass. provides content
            access and racing experiences only.
          </p>
          <img className="pc-mark" src="/marketing/ec7c405b.png" alt="" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
