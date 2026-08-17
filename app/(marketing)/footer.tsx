import { legalPath } from "@/lib/legal";

import { contactMailtoHref } from "./modals/contact-mailto";
import FaqSheet from "./modals/faq-sheet";

/**
 * Marketing footer — ported from the signed-off mockup (Concept B v2.6/v2.7),
 * wired up by ENG-589 / W3.
 *
 * W2 shipped the Support and Legal entries as inert `<button data-sheet="…">`,
 * as the mockup has them, because in the design they open an overlay. Both
 * columns are now real anchors instead, which is W3's single declared edit here:
 *
 *   - **Legal** → W4's `/legal/*` routes (decision 7). The sheets are not ported;
 *     W4 owns that content as real pages. `legalPath()` is W4's own helper, so
 *     the four hrefs cannot drift from the four routes it prerenders.
 *   - **Support** → a `mailto:` carrying the same `data-subject` the mockup's
 *     buttons had (decision 6). No form, and above all no confirmation of
 *     delivery: v2.6 acknowledged a send that never happened. (Its wording is
 *     not quoted here — a guardrail test greps the built output for it.)
 *
 * Anchors rather than delegated buttons on purpose: the client reviews this page
 * with scripting blocked, and the acceptance criterion is that the legal links
 * navigate and the contact mailto still works with no JS. A `<button>` needs the
 * delegate; an `<a href>` needs nothing.
 *
 * `<FaqSheet/>` mounts here because the footer is on every marketing page. It
 * renders `#sheet-faq` and binds the `[data-sheet]` delegate that still serves
 * the triggers in `sections/faq.tsx` and `sections/for-trainers.tsx`, neither of
 * which this ticket may touch.
 *
 * The mockup prints no email address anywhere so it cannot be scraped. That
 * still holds: the address is in the href, never in the text.
 */

/** The mockup's four Legal entries, in its order, against W4's four slugs. */
const LEGAL_LINKS: ReadonlyArray<{ label: string; slug: string }> = [
  { label: "Privacy Policy", slug: "privacy" },
  { label: "Terms & Conditions", slug: "terms" },
  { label: "Cancellation & Refund Policy", slug: "cancellation" },
  { label: "Acceptable Use Policy", slug: "acceptable-use" },
];

/** The mockup's three Support entries and the `data-subject` each carried. */
const CONTACT_LINKS: ReadonlyArray<{ label: string; subject: string }> = [
  { label: "Contact us", subject: "General enquiry" },
  { label: "Subscriber support", subject: "Subscriber support" },
  { label: "Trainer partnerships", subject: "Trainer partnerships" },
];

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
              {CONTACT_LINKS.map(({ label, subject }) => (
                <li key={label}>
                  <a href={contactMailtoHref(subject)}>{label}</a>
                </li>
              ))}
            </ul>
          </div>
          <div className="foot-col">
            <h4>Legal</h4>
            <ul>
              {LEGAL_LINKS.map(({ label, slug }) => (
                <li key={slug}>
                  <a href={legalPath(slug)}>{label}</a>
                </li>
              ))}
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
      <FaqSheet />
    </footer>
  );
}
