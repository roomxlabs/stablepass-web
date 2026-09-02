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
import WaitlistForm from "../waitlist-form";

export default function Hero({ joined, reason }: { joined?: string | null; reason?: string | null }) {
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
              {/* Hidden pre-launch with the rest of the pricing: the badge
                  advertises the launch offer, and waitlist mode does not sell a
                  price. Marked `launch-only` rather than deleted — the copy
                  freeze requires every hide in this mode to be CSS-only, so the
                  text stays in the DOM and the launch switch-back needs no
                  markup back. */}
              <span className="chip-sep launch-only">·</span>
              <b className="launch-only">LAUNCH OFFER · $9/MONTH FOR YOUR FIRST 6 MONTHS</b>
            </span>
            {/* Justin, 1 Sep: "Experience needs to be on the second line", then
                "made simple needs to be a new line" — so all three breaks are
                explicit. This is the mockup's own three-line setting; without
                the breaks `text-wrap: balance` re-flows it to two. */}
            <h1>
              The racing
              <br />
              experience
              <br />
              made simple.
            </h1>
            <p className="hero-sub">
              Get closer to the horse, stables and stories in thoroughbred racing with behind-the-scenes updates,
              photos, videos, race previews and stable content from participating trainers. stablepass. gives
              subscribers a simple way to follow real racehorses, real stables, and real racing stories, all in one
              place.
            </p>
            {/*
              Justin's wording, 1 Sep 2026: the standing price leads, and the
              introductory price sits PROMINENTLY under it as a "Launch Offer"
              rather than replacing it — so the $19 is what a subscriber reads
              as the real price and the $9 is plainly temporary.
            */}
            {/* Justin, 1 Sep: "Maybe take out the first $19 per month line" — it
                repeated the "$19/month thereafter" line two rows below, so the
                launch price now leads and the standing price follows it once. */}
            <p className="hero-launch cta-trial">Launch Offer — $9/month for your first 6 months.</p>
            <p className="hero-price hero-price-sub cta-trial">
              $19/month thereafter. Cancel anytime. No lock-in contract.
              <br />
              Follow the journey. Feel part of the action.
            </p>
            {/* Pre-launch, the offer copy above is hidden with the rest of the
                pricing and this line leads instead. Deliberately says nothing
                about a trial: the 30-day trial is not the offer any more
                (Naufal, 2 Sep). */}
            <p className="hero-price cta-waitlist">
              Join the waitlist to be first to receive exclusive updates on our launch and special offers.
            </p>
            <div className="cta-waitlist wl-mount">
              <WaitlistForm initialJoined={joined} initialReason={reason} />
            </div>
            <div className="hero-actions">
              <a className="btn btn-green cta-trial" href="/start">
                Get the $9/month offer
              </a>
              <a className="btn btn-green cta-join" href="/start">
                Join stablepass.
              </a>
              <a className="btn btn-ghost" href="#how">
                See how it works
              </a>
            </div>
            <p className="hero-fine cta-trial">
              $9/month for your first 6 months when you sign up on or before 30 November 2026.
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
                  src="/marketing/63a46fb0.jpg"
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

/**
 * Justin's list for the scrolling banner, 2 Sep 2026, in his order. Set in caps
 * because the ribbon has no `text-transform` — the casing lives in the strings,
 * and the mono treatment is the mockup's.
 */
const RIBBON_WORDS = [
  "RACE PREVIEWS",
  "BEHIND-THE-SCENES ACCESS",
  "STABLE PHOTOS",
  "SUBSCRIBER-ONLY CONTENT",
  "STABLE INSIGHTS",
  "RACE DAY ALERTS",
  "STABLE VIDEOS",
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
