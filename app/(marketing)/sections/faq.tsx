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

const FAQS = [
  {
    q: "What is stablepass.?",
    a: "stablepass. is a monthly racing experience subscription that gives subscribers access to behind-the-scenes content from participating thoroughbred racing stables.",
  },
  {
    q: "Is there a free trial?",
    a: "Yes. Every new subscriber starts with a free 30 day trial. No credit card is required to start, and you can cancel any time before the trial ends without being charged.",
  },
  {
    q: "How much does stablepass. cost?",
    a: "stablepass. subscription is $19 per month once your free 30 day trial finishes.",
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
            <details key={item.q}>
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
