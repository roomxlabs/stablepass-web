// The access wall — the one place the web app says "you can't see this, here's
// why, here's what to do about it" (ENG-585).
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// It used to be eight copies. Explore, Following, Saved, the horses grid, the
// trainers grid, both profile pages and onboarding each hardcoded their own
// version of the same card, and every one of them told the member that their
// introductory period had ended and invited them to "reactivate" a
// subscription. Both halves were wrong for the member who found that bug: they
// had converted to a paid pass and PAID for it, so nothing introductory had
// ended. Eight copies is also why it stayed wrong: nobody was going to fix the
// same sentence eight times. Now the copy lives once, here — which is what made
// the ENG-1022 correction below a four-line change instead of another sweep.
//
// (That paragraph also used to argue that "reactivate" was wrong because
// nothing renewed. Under auto-renew a paused subscription is precisely a thing
// you restart, so the CTA says so again. Kept as a record of how completely a
// billing-model change can invert this file's vocabulary.)
//
// ── WHAT THE SPLIT MEANS NOW (ENG-1008) ─────────────────────────────────────
// ENG-999 retired the introductory free period outright — the status it used is
// no longer valid and `handle_new_user()` provisions `lapsed` — and ENG-1003
// took it out of the funnel, so a new account goes straight to /checkout. That
// left the "never paid" half of this table describing something no member has
// ever had: a ninety-second-old account was told it had used up 30 free days it
// was never offered. The split itself is still right; it is simply no longer
// about that retired offer. It is:
//
//     never subscribed   → they need their FIRST subscription
//     subscribed before  → theirs is not running and access is paused
//
// Both branches send the member to the same place; only the sentence that
// explains why differs. Keep them distinguishable — those are two genuinely
// different account histories and they want different words.
//
// ── THE COPY IS SHARED WITH MOBILE — DO NOT DRIFT ───────────────────────────
// Titles and CTAs were VERBATIM from mobile's gate wall (stablepass-mobile
// `src/app/(gate)/reactivate.tsx`, ENG-573), which branches on exactly the same
// bit. A member who gets kicked out on their phone and then opens the laptop
// must read the same sentence, not two theories about what happened to their
// account. ENG-1004 is the mobile side of this same retirement and re-lands the
// parity; until it does, the never-subscribed title is deliberately ahead of
// mobile rather than knowingly false on the web.
//
// The one thing that must NOT be carried across is the CTA TREATMENT. This wall
// links to /checkout because the web IS the place you buy. **Never copy that
// link into stablepass-mobile** — the iOS app carries no pointer to an external
// purchase (App Store 3.1.3(a)).
//
// ── GUARDRAILS ──────────────────────────────────────────────────────────────
// * This component is CHROME, not a gate. It decides which SENTENCE to show, it
//   never decides who sees content — callers pass `everSubscribed` already
//   resolved, and entitlement itself comes from `hasAccess()` / the BFF's 402.
// * `everSubscribed` is a BOOLEAN by design. `stripe_customer_id` is resolved
//   server-side and never crosses into client JS (.rx/guardrails.md #1).
// * The copy MUST say the subscription renews. This guardrail was the exact
//   opposite until the auto-renew epic (ENG-1022) landed — it read "no copy
//   here states or implies the pass renews", which was correct for the 30-day
//   non-renewing pass and became false the moment ENG-1028 shipped monthly
//   auto-renewal. Both halves of this file said "it never renews on its own"
//   while /checkout, one click later, said "Your subscription renews monthly
//   until you cancel". Whichever the member read second, one of them was a lie
//   — and telling an Australian consumer a purchase does not auto-renew before
//   enrolling them in one is not merely a copy defect. If the billing model
//   changes again, this sentence changes WITH it, in the same PR.
// * No cancel / payment-method affordance: the only action is starting or
//   restarting the subscription. Managing a live one belongs on /account.
// * **No amount, ever — not even in a comment.** There are two prices, and
//   which one a given member is offered depends on their intro counter and is
//   decided server-side (ENG-1001). A number written here would be wrong for
//   half the people who read it, and a stale one in a comment is how it gets
//   copied back into the copy. Say "a subscription".

/**
 * The two things the wall can be. They are NOT interchangeable, and the
 * difference is the whole bug — twice over. Telling someone who has paid us
 * that their access lapsed for nothing reads as though the payment never
 * registered; telling someone who has never paid that an introductory period of
 * theirs ran out invents an account history they do not have.
 */
export const WALL_COPY = {
  // No `stripe_customer_id` — never a Stripe customer, so they have never
  // subscribed. (Renamed by ENG-1008 — the offer the old key named is gone.)
  neverSubscribed: {
    title: "You don't have a subscription yet",
    body: "Subscribe to see every update from the stables you follow. It renews monthly and you can cancel any time.",
    cta: "Get full access",
  },
  // Has a `stripe_customer_id` — they have subscribed before, so the
  // subscription is cancelled, or a renewal did not go through.
  paused: {
    title: "Your access has paused",
    body: "Your subscription isn't running right now. Start it again to pick up where you left off — it renews monthly and you can cancel any time.",
    cta: "Restart my subscription",
  },
} as const;

export type WallCopy = (typeof WALL_COPY)[keyof typeof WALL_COPY];

/** The sentence this member should read. The single branch, written once. */
export function accessWallCopy(everSubscribed: boolean): WallCopy {
  return everSubscribed ? WALL_COPY.paused : WALL_COPY.neverSubscribed;
}

/**
 * `card` is the in-column `.aside-card` every member screen already used;
 * `hero` is onboarding's full-width `.onboarding-empty` centre stage. Both skins
 * pre-date this file — nothing new is introduced to the design system, the two
 * existing treatments are just fed from one string table now.
 */
export type AccessWallVariant = "card" | "hero";

export function AccessWall({
  everSubscribed,
  variant = "card",
}: {
  everSubscribed: boolean;
  variant?: AccessWallVariant;
}) {
  const copy = accessWallCopy(everSubscribed);

  if (variant === "hero") {
    return (
      <div className="onboarding-empty" data-testid="access-wall">
        <h1 className="onboarding-h">{copy.title}</h1>
        <p className="onboarding-sub">{copy.body}</p>
        <a className="btn btn-primary btn-large" href="/checkout">
          {copy.cta}
        </a>
      </div>
    );
  }

  return (
    <div className="aside-card" data-testid="access-wall">
      <h3>{copy.title}</h3>
      <p style={{ color: "var(--muted)", marginBottom: 16 }}>{copy.body}</p>
      <a className="btn btn-primary" href="/checkout">
        {copy.cta}
      </a>
    </div>
  );
}
