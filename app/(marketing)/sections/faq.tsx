/**
 * Section 10 — `section#faq.sec`, "Good Questions" (ENG-588 / W2).
 *
 * Nav target for "FAQ", and the footer's "FAQ" link.
 *
 * `<details>/<summary>` is not a stylistic choice — it is the acceptance
 * criterion. The client reviews this page on a phone with JavaScript blocked, so
 * the accordion has to open and close with no script at all. Native disclosure
 * elements do exactly that, and marketing.css styles them; do not replace them
 * with a state hook.
 *
 * The "View all" button carries `data-sheet="faq"` and is INERT here. W3
 * (ENG-589) opens the full FAQ sheet from it via an event delegate, without
 * editing this file — it is in W3's declared DOM contract.
 */

/**
 * ENG-1324 (Pricing v2) deleted the "Is there an introductory offer?" entry
 * outright — the six-month promo is retired (epic ENG-1321, decision 5), and a
 * reworded promo answer would keep pitching something we no longer sell. The
 * cost answer survives, because a pricing FAQ that cannot say the price is a
 * regression; it now carries the trial, the one standing price, and the
 * same-price-everywhere promise the epic exists to deliver.
 *
 * `launchOnly` marks the pricing question. Pre-launch it is hidden with
 * the rest of the pricing (Naufal, 2 Sep) rather than deleted, for the same
 * reason as every other hide in this mode: the copy freeze requires the text to
 * stay in the DOM, and the launch switch-back is then a mode flip with no copy
 * to restore.
 */
const FAQS = [
  {
    q: "What is stablepass.?",
    a: "stablepass. is a monthly racing experience subscription that gives subscribers access to behind-the-scenes content from participating thoroughbred racing stables.",
  },
  {
    launchOnly: true,
    q: "How much does stablepass. cost?",
    a: "stablepass. is 30 days free, then A$9.99 per month. Cancel anytime. The price is the same on the website, the App Store and Google Play.",
  },
  {
    q: "What do subscribers receive?",
    a: "Subscribers receive access to stable updates, photos, videos, horse progress reports, race previews, race follow-ups, and other subscription-only racing content from participating stables.",
  },
  {
    q: "Is stablepass. a syndicate?",
    a: "No. stablepass. is not a syndicate. stablepass. is a content and experience subscription only.",
  },
  {
    q: "Do subscribers receive shares or prize money?",
    a: "No. stablepass. does not sell shares in racehorses, and subscribers do not receive prize money, financial returns, betting returns, or sale proceeds.",
  },
  {
    q: "Can I cancel my subscription?",
    a: "Yes. Subscribers can cancel their monthly subscription anytime.",
  },
];

export default function Faq() {
  return (
    <section className="sec" id="faq">
      <div className="wrap">
        <div className="sec-head center rv" suppressHydrationWarning>
          <span className="eyebrow">FAQ</span>
          <h2>Good Questions</h2>
        </div>
        <div className="faq rv" suppressHydrationWarning>
          {FAQS.map((item) => (
            <details key={item.q} className={item.launchOnly ? "launch-only" : undefined}>
              <summary>{item.q}</summary>
              <p className="a">{item.a}</p>
            </details>
          ))}
          <div className="faq-cta">
            <button className="btn btn-ghost" type="button" data-sheet="faq">
              View all
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
