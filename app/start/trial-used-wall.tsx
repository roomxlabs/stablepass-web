import Link from "next/link";

// The repeat-signup wall (ENG-763, R22). Shown instead of the trial-start form
// when the free trial has already been taken by this phone number or this email
// address.
//
// DELIBERATELY NOT A CLIENT COMPONENT, and that is the whole point.
// Two callers render this exact markup:
//   1. app/start/trial-start-form.tsx, client-side, after /api/auth/signup
//      answers 409 `trial_already_used`;
//   2. app/start/page.tsx, SERVER-side, for `/start?trial=used`.
// (2) exists because this screen is reviewed on a phone with JavaScript
// blocked. A wall that only ever appears as the result of a `fetch()` is
// invisible to that reviewer and to anything else without scripting, so the
// same component is reachable as plain server-rendered HTML with a real
// `<a href>` out of it. One component, so the two paths cannot drift.
//
// NO NEW CSS, on purpose. Every class here already exists in app/globals.css
// and every one of them is used by the trial-start mockup itself
// (06-stage1-design/mockups/web/screens/03-trial-start.html): `.auth-card`,
// `.trial-banner-web` + `.trial-label`/`.trial-detail`, and an ANCHOR carrying
// `.btn.btn-primary.btn-block.btn-large` (the mockup's own "Start free trial"
// is an `<a>`, not a `<button>`, so a link styled as the primary action is the
// design's pattern and not an invention here). `.trial-banner-web` is the
// established treatment for an informational band on this screen family —
// app/(member)/expiry-banner.tsx already reuses it for the same reason.
// Adding a rule instead would have cost a sanction entry in
// marketing-shell.test.tsx's rule-for-rule diff and risked colliding with the
// parallel carousel ticket, which owns the other end of globals.css.
//
// `next/link` rather than a raw `<a>`: `/signin` and `/start` are both real
// pages, so a bare anchor to them trips `@next/next/no-html-link-for-pages`.
// The three pre-existing raw anchors in trial-start-form.tsx are ENG-598's to
// convert, and this file deliberately does not add a fourth. Link still renders
// a real `<a href>` in the server HTML, so the JS-blocked path above is intact.
//
// `role="status"` announces the swap to a screen reader when the client path
// replaces the form in place, where there is no navigation to announce it.
// Deliberately NOT `role="alert"`: this is not an error, it is an outcome, and
// Playwright's `getByRole("alert")` is already ambiguous on this app because
// Next's route announcer claims that role too (.rx/gotchas.md).
//
// COPY. "$19 per month" is the signed-off PUBLIC price string, matching
// app/(marketing)/sections/{hero,pricing,faq}.tsx and content/legal/terms.md.
// It is not in tension with the "never hardcode the price" rule: that rule
// governs screens quoting the amount being CHARGED (checkout and account format
// every figure from Stripe's `unitAmount`, because the sandbox price is A$1.00
// and production A$19.00). This is the public funnel making the same offer the
// marketing page makes, and the member sees the real Stripe-derived figure at
// checkout before paying anything.
//
// The wall never says WHICH credential matched. Phone and email hits render the
// identical message by design (ENG-763's resolved open question), so the page
// discloses nothing beyond the yes/no the member could already infer from
// seeing it at all.
export function TrialUsedWall() {
  return (
    <div className="auth-card" role="status">
      <h1>Looks like you&rsquo;ve already had your free trial.</h1>
      <p className="auth-sub">
        Your account is still here. Sign in to join stablepass and pick up right where you
        left off.
      </p>

      <div className="trial-banner-web">
        <div className="trial-label">Join stablepass</div>
        <div className="trial-detail">
          Full access to every stable update, race day report and replay for $19 per month.
          Cancel anytime.
        </div>
      </div>

      <Link className="btn btn-primary btn-block btn-large" href="/signin">
        Sign in to join
      </Link>

      <div className="auth-foot">
        Typed the wrong details? <Link href="/start">Start over</Link>
      </div>
    </div>
  );
}
