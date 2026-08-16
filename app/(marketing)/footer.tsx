/**
 * Marketing footer — ported from the signed-off mockup (Concept B v2.6).
 *
 * The Support and Legal entries are <button data-sheet="…">, not links, exactly
 * as the mockup has them: in the design they open an overlay rather than
 * navigate. They are inert here by design — W3 (ENG-589) wires the sheet
 * behaviour, W4 (ENG-590) gives the legal ones real /legal/<slug> URLs. They
 * render as buttons now so neither slice has to restructure this markup.
 *
 * No email address is printed anywhere, deliberately: the mockup routes contact
 * through a form so the address cannot be scraped.
 */
export default function MarketingFooter() {
  return (
    <footer>
      <div className="wrap">
        <div className="foot-top">
          <div className="foot-brand">
            {/* eslint-disable-next-line @next/next/no-img-element -- ENG-587 decision 6:
                plain <img>, sized by CSS exactly as the mockup does. */}
            <img src="/marketing/3499d96c.png" alt="stablepass." />
            <p>A thoroughbred racing experience and entertainment subscription.</p>
            <div className="foot-social">
              <a href="#" data-social="Instagram" aria-label="stablepass. on Instagram">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
                  <rect x="3" y="3" width="18" height="18" rx="5" />
                  <circle cx="12" cy="12" r="4" />
                  <circle cx="17.2" cy="6.8" r="1.1" fill="currentColor" stroke="none" />
                </svg>
              </a>
              <a href="#" data-social="Facebook" aria-label="stablepass. on Facebook">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M14.1 21v-7.4h2.5l.4-2.9h-2.9V8.9c0-.8.2-1.4 1.4-1.4h1.6V4.9c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.2H8.4v2.9h2.5V21Z" />
                </svg>
              </a>
              <a href="#" data-social="X" aria-label="stablepass. on X">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.2 4h2.8l-6.1 7 7.2 9h-5.6l-4.4-5.7L5.9 20H3.1l6.5-7.5L2.7 4h5.8l4 5.3Zm-1 14.3h1.5L8 5.6H6.4Z" />
                </svg>
              </a>
            </div>
          </div>
          <div className="foot-col">
            <h4>Explore</h4>
            <ul>
              <li>
                <a href="#top">Home</a>
              </li>
              <li>
                <a href="#how">How It Works</a>
              </li>
              <li>
                <a href="#subscription">Subscription</a>
              </li>
              <li>
                <a href="#stable-trainers">Our Trainers</a>
              </li>
              <li>
                <a href="#trainers">For Trainers</a>
              </li>
            </ul>
          </div>
          <div className="foot-col">
            <h4>Support</h4>
            <ul>
              <li>
                <a href="#faq">FAQ</a>
              </li>
              <li>
                <button type="button" data-sheet="contact" data-subject="General enquiry">
                  Contact us
                </button>
              </li>
              <li>
                <button type="button" data-sheet="contact" data-subject="Subscriber support">
                  Subscriber support
                </button>
              </li>
              <li>
                <button type="button" data-sheet="contact" data-subject="Trainer partnerships">
                  Trainer partnerships
                </button>
              </li>
            </ul>
          </div>
          <div className="foot-col">
            <h4>Legal</h4>
            <ul>
              <li>
                <button type="button" data-sheet="privacy">
                  Privacy Policy
                </button>
              </li>
              <li>
                <button type="button" data-sheet="terms">
                  Terms &amp; Conditions
                </button>
              </li>
              <li>
                <button type="button" data-sheet="terms">
                  Cancellation &amp; Refund Policy
                </button>
              </li>
              <li>
                <button type="button" data-sheet="terms">
                  Acceptable Use Policy
                </button>
              </li>
            </ul>
          </div>
        </div>
        <div className="foot-legal">
          <div className="row">
            <span>© stablepass. All rights reserved.</span>
            {/* Mockup review stamp, ported verbatim per decision 1 (the design is frozen).
                Bumped to V2.7 with the source, which re-cut the post-race stat tile off the
                starting price. Flagged on the PR: a production footer arguably should not
                name the concept and the agency at all — but dropping it is a copy decision,
                not mine. */}
            <span>Concept B · “Race Day” · V2.7 · RX Labs</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
