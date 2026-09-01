/**
 * Section 9 — the unnamed CTA band, "Your racing experience starts here."
 * (ENG-588 / W2).
 *
 * The only section with no class on the `<section>` itself: the mockup styles it
 * entirely through the inner `.wrap.cta`, and puts the padding inline. Both
 * inline styles are carried over rather than invented, since marketing.css is
 * W1's and has no rule for them.
 *
 * `.cta-bg` is the photograph, set as a CSS background so it can be cropped by
 * the band rather than sized by the intrinsic image. It therefore needs
 * `role="img"` + `aria-label` to carry the description an `<img alt>` would.
 */
export default function CtaBand() {
  return (
    <section style={{ padding: "96px 28px 0" }}>
      <div className="wrap cta rv" suppressHydrationWarning style={{ paddingLeft: 40, paddingRight: 40 }}>
        <div className="cta-bg" role="img" aria-label="Subscribers watch the field race past the grandstand" />
        <div className="cta-veil" />
        <div className="cta-fill" aria-hidden="true" />
        <div className="cta-in">
          <h2>Your racing experience starts here.</h2>
          <p>
            Join stablepass. and follow the stories, stables, horses, and race day moments that make racing exciting.
          </p>
          <p className="cta-trial-line">Join stablepass. $9/month for your first 6 months, then $19/month.</p>
          <a className="btn btn-cream cta-trial" href="/start">
            Get the $9/month offer
          </a>
          <a className="btn btn-cream cta-join" href="/start">
            Join stablepass.
          </a>
        </div>
      </div>
    </section>
  );
}
