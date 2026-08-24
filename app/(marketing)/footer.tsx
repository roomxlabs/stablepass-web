import { legalPath } from "@/lib/legal";
import { getMarketingTrainers } from "@/lib/marketing/trainers";

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

export default async function MarketingFooter() {
  // ENG-730: "Our Trainers" is an in-page anchor to `#stable-trainers`, and that
  // section now disappears whenever no stable is published — which is the LAUNCH
  // state, since `trainer.marketing_visible` defaults to false.
  //
  // ENG-589 flagged this exact link when it asserted the empty strip:
  // "the footer links `#stable-trainers` unconditionally, so hiding the section
  // leaves that link with no target... the fix belongs with whoever makes the
  // list dynamic". That is this ticket, so the link is picked up here rather
  // than left as a second dead anchor beside the one W3 already had to hide.
  //
  // The read is the SAME `unstable_cache` entry the page uses, so this costs no
  // extra round trip — it is one cached roster shared by both components.
  //
  // It is a JSX condition rather than a CSS rule on purpose: `marketing.css` is
  // W3's file and is diffed rule-for-rule against the mockup, so a new rule here
  // would fail that guard, and W3's `.launch-only` hook is keyed to the waitlist
  // MODE, which is a different question from whether any stable is published.
  const hasTrainers = (await getMarketingTrainers()).length > 0;

  return (
    <footer>
      <div className="wrap">
        <div className="foot-top">
          <div className="foot-brand">
            {/* eslint-disable-next-line @next/next/no-img-element -- ENG-587 decision 6:
                plain <img>, sized by CSS exactly as the mockup does. */}
            <img src="/marketing/3499d96c.png" alt="stablepass." />
            <p>A thoroughbred racing experience and entertainment subscription.</p>
            {/* ENG-600: the Instagram / Facebook / X icons were removed. All three were
                `href="#"` in the mockup — no account URLs exist anywhere in the project.
                Three icons that go nowhere are worse than none on a live site. The SVG
                paths and the `.foot-social` styles are kept in git history; re-add the
                block once the handles exist, which is a one-commit change. */}
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
              {/* ENG-729: hidden in waitlist mode, where `#subscription` is a
                  dead anchor — the section it points at is hidden too. The
                  whole <li> goes, not just the link, so the column does not
                  keep a blank row where the entry was. */}
              <li className="launch-only">
                <a href="#subscription">Subscription</a>
              </li>
              {hasTrainers && (
                <li>
                  <a href="#stable-trainers">Our Trainers</a>
                </li>
              )}
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
            {/* ENG-600: the "Concept B · Race Day · V2.7 · RX Labs" stamp was removed.
                It was a mockup review marker naming the internal concept and the agency
                on a customer-facing page. W3 flagged it; this is the decision. Do not
                reintroduce it when re-porting from the mockup. */}
          </div>
        </div>
      </div>
      <FaqSheet />
    </footer>
  );
}
