/**
 * Marketing nav — ported from the signed-off mockup (Concept B v2.6).
 *
 * Every destination is an in-page anchor. `html{scroll-behavior:smooth}` in
 * marketing.css does the scrolling, so there is no handler here and the nav
 * works with scripting off. The targets are sections W2 lands; until then the
 * links resolve to nothing, which is the accepted W1 state.
 *
 * The wordmark is the extracted asset, not an inlined data URI. It has no
 * width/height attributes because the mockup gives it none — `.nav-logo img`
 * fixes the height in CSS.
 */
export default function MarketingNav() {
  return (
    <nav className="nav">
      <div className="nav-in">
        <a className="nav-logo" href="#top" aria-label="stablepass home">
          {/* eslint-disable-next-line @next/next/no-img-element -- ENG-587 decision 6:
              the mockup sizes every image with CSS (img{max-width:100%;height:auto}),
              and next/image changes that layout behaviour. Plain <img> is deliberate. */}
          <img src="/marketing/3499d96c.png" alt="stablepass." />
        </a>
        <div className="nav-links">
          <a href="#how">How it works</a>
          <a href="#app">The app</a>
          <a href="#subscription">Subscription</a>
          <a href="#trainers">For trainers</a>
          <a href="#faq">FAQ</a>
        </div>
        <a className="nav-cta" href="#subscription">
          Join stablepass.
        </a>
      </div>
    </nav>
  );
}
