/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS (img{max-width:100%;height:auto}) and next/image changes that
   layout behaviour. Plain <img> is deliberate across the whole marketing route group. */

/**
 * Section 1 — `header#top.hero` plus the keyword ribbon (ENG-588 / W2).
 *
 * The ribbon is a sibling of the header in the mockup, not a child, and it has no
 * id of its own — it belongs to the hero visually, so it ships in this file rather
 * than earning a thirteenth component.
 *
 * `id="top"` moves here off W1's stub: the nav wordmark and the footer's "Home"
 * both anchor to it, matching the mockup's `<header class="hero" id="top">`.
 *
 * Both CTA variants are rendered. `.marketing[data-cta-mode]` in marketing.css
 * hides whichever one is not leading, so the choice is a layout attribute rather
 * than a branch here — W5 turns it into a setting.
 *
 * The ribbon's scroll is a CSS keyframe (`animation:slide 38s linear infinite`),
 * so it runs with scripting off and stops under prefers-reduced-motion, both from
 * W1's stylesheet. Nothing in this file needs JS.
 */
export default function Hero() {
  return (
    <>
      <header className="hero" id="top">
        <div className="hero-oval" aria-hidden="true" />
        <span className="hero-mark" aria-hidden="true">
          S
        </span>
        <div className="wrap hero-in">
          <div className="hero-copy">
            <span className="hero-chip">
              <span className="chip-l1">
                <i />
                RACING EXPERIENCE SUBSCRIPTION
              </span>
              <span className="chip-sep">·</span>
              <b>FIRST 30 DAYS FREE</b>
            </span>
            <h1>The racing experience made simple.</h1>
            <p className="hero-sub">
              Get closer to the horse, stables and stories in thoroughbred racing with behind-the-scenes updates,
              photos, videos, race previews and stable content from participating trainers. stablepass. gives
              subscribers a simple way to follow real racehorses, real stables, and real racing stories, all in one
              place.
            </p>
            <p className="hero-price">
              Join for $19 per month. Cancel anytime.
              <br />
              Follow the journey. Feel part of the action.
            </p>
            <div className="hero-actions">
              <a className="btn btn-green cta-trial" href="/start">
                Start your free 30 day trial
              </a>
              <a className="btn btn-green cta-join" href="/start">
                Join stablepass.
              </a>
              <a className="btn btn-ghost" href="#how">
                See how it works
              </a>
            </div>
            <p className="hero-fine cta-trial">
              Free for 30 days, no credit card required. $19 per month after that, cancel anytime.
            </p>
          </div>
          <div className="hero-vis">
            <figure className="hero-photo">
              <img
                src="/marketing/a65c5702.jpg"
                alt="A racehorse and jockey at full stride down the straight"
                width={1000}
                height={1175}
              />
            </figure>
            <div className="phone">
              <div className="ph-view">
                <span className="ph-island" />
                <img
                  className="shot"
                  src="/marketing/42017d50.jpg"
                  alt="stablepass app: explore feed with a trackwork video update"
                />
                <span className="ph-home" />
              </div>
            </div>
          </div>
        </div>
      </header>

      <div className="ribbon" aria-hidden="true">
        <div className="ribbon-track">
          {/* Duplicated once so the keyframe's -50% translate loops seamlessly. */}
          {[0, 1].map((set) => (
            <RibbonSet key={set} />
          ))}
        </div>
      </div>
    </>
  );
}

const RIBBON_WORDS = [
  "STABLE UPDATES",
  "RACE PREVIEWS",
  "BEHIND-THE-SCENES PHOTOS",
  "SHORT VIDEOS",
  "RACE DAY ALERTS",
  "STABLE INSIGHTS",
  "SUBSCRIBER-ONLY CONTENT",
];

function RibbonSet() {
  return (
    <>
      {RIBBON_WORDS.map((word) => (
        <span key={word}>{word}</span>
      ))}
    </>
  );
}
