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
 * `.cta-trial-line` is `.launch-only`. An earlier pass left it visible, reasoning
 * that trial-mentioning prose is scoped OUT of this ticket and that this line is
 * prose rather than a link. Both are true and the conclusion was still wrong,
 * because the reasoning was done without looking at the rendered state:
 * marketing.css opens `@media (hover:none)` and un-collapses this line outright
 * (`max-height:4em;opacity:1`) — the band's hover reveal never fires on a touch
 * device, so the line is simply ON. Every phone therefore read
 * "Join stablepass. Enjoy your free 30 day trial." directly above a form whose
 * entire premise is that you cannot join yet, under a heading that already says
 * "Join stablepass. and follow the stories…". Two invitations to join, on the
 * page that exists because joining is not open.
 *
 * `.launch-only` rather than `.cta-trial`: it hides the line in waitlist mode
 * ONLY, so trial and join modes keep rendering it exactly as they do today and
 * the switch-back stays byte-identical. It also costs no new CSS rule.
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
          <p className="cta-trial-line launch-only">Join stablepass. $9/month for your first 6 months, then $19/month.</p>
          <a className="btn btn-cream cta-trial" href="/start">
            Get the $9/month offer
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
