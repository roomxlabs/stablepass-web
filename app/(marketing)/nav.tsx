/**
 * Marketing nav — ported from the signed-off mockup (Concept B v2.6).
 *
 * Section destinations are in-page anchors. `html{scroll-behavior:smooth}` in
 * marketing.css does the scrolling, so there is no handler here and the nav
 * works with scripting off.
 *
 * ENG-600: the two product destinations are ROOT-RELATIVE, not absolute, and
 * not built from `APP_HOST`. On the apex, middleware.ts:239 already 307s any
 * non-shared path to the same path on the app host, so `/start` lands on
 * `app.stablepass.co/start` for free. An absolute URL would additionally send
 * local dev straight at production. The cost is one redirect hop per click,
 * which is the same trade W4 took for the legal links.
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
        {/* Sign in is grouped with the CTA, NOT inside .nav-links, because
            `.nav-links{display:none}` at <=880px would otherwise hide the only
            route back to an account on exactly the devices most likely to need
            it. Muted against the solid CTA: returning subscribers are the
            smaller audience, so it must be findable without competing. */}
        <div className="nav-actions">
          <a className="nav-signin" href="/signin">
            Sign in
          </a>
          <a className="nav-cta" href="/start">
            Join stablepass.
          </a>
        </div>
      </div>
    </nav>
  );
}
