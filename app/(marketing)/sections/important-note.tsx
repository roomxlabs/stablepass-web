/**
 * Section 12 — `section.wrap.note-band`, the "Important note" (ENG-588 / W2).
 *
 * This is the load-bearing one for guardrail #8. The paragraph below is the
 * client's regulator-facing wording, and it is a list of things stablepass. does
 * NOT sell. Every prohibited term in it is there to disclaim the thing, never to
 * offer it.
 *
 * DO NOT paraphrase, reflow into different sentences, or "tidy" it. It is
 * reproduced character-for-character from the signed-off mockup, and
 * test/marketing-home.test.tsx asserts the rendered text against a literal copy
 * of that string so a well-meaning edit fails the build instead of shipping.
 *
 * It sits in its own white band directly above the footer rather than inside it,
 * so the same disclaimer is never printed twice in a row.
 */
export default function ImportantNote() {
  return (
    <section className="wrap note-band">
      <div className="foot-note">
        <svg className="shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M12 3 4 6.5v5c0 5 3.4 8 8 9.5 4.6-1.5 8-4.5 8-9.5v-5Z" />
          <path d="M12 8v5" />
          <circle cx="12" cy="16.2" r=".4" />
        </svg>
        <div>
          <h3>Important note</h3>
          <p>
            stablepass. is an entertainment and experience subscription. stablepass. does not sell shares in
            racehorses, syndicates, financial products, betting products, prize money rights, or investment returns.
            Subscribers receive content access and racing experiences only.
          </p>
        </div>
      </div>
    </section>
  );
}
