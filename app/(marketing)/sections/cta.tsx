import WaitlistForm from "../waitlist-form";

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
 *
 * ENG-729 mounts the second capture form here, the band being the page's other
 * conversion site (ENG-721 decision 1). As in the hero, the trial/join anchors
 * stay in the DOM and are hidden by mode, so the launch switch-back is one line
 * in layout.tsx.
 *
 * `.cta-trial-line` deliberately keeps its copy. It is the band's hover-reveal
 * line and it promises the same 30-day trial the waitlist line promises; the
 * ticket scopes trial-mentioning prose (the FAQ, this line) as OUT, since the
 * waitlist enables that trial rather than replacing it. What it must NOT do is
 * offer a route to /start, and it does not — it is prose, not a link.
 */
export default function CtaBand({ joined, reason }: { joined?: string | null; reason?: string | null }) {
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
          <p className="cta-trial-line">Join stablepass. Enjoy your free 30 day trial.</p>
          <a className="btn btn-cream cta-trial" href="/start">
            Start your free 30 day trial
          </a>
          <a className="btn btn-cream cta-join" href="/start">
            Join stablepass.
          </a>
          <div className="cta-waitlist wl-mount">
            <WaitlistForm initialJoined={joined} initialReason={reason} />
          </div>
        </div>
      </div>
    </section>
  );
}
