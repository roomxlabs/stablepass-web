// The access wall — the one place the web app says "you can't see this, here's
// why, here's what to do about it" (ENG-585).
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// It used to be eight copies. Explore, Following, Saved, the horses grid, the
// trainers grid, both profile pages and onboarding each hardcoded their own
// version of the same card, and every one of them said:
//
//     "Your trial has ended. Reactivate your subscription to …"
//
// Both halves of that sentence were wrong for the member who found this bug:
// they had converted to a paid pass and PAID for it, so no trial had ended —
// and "reactivate" is vocabulary from the auto-renewing plan this epic removed.
// There is nothing to reactivate; the pass simply ends and you buy another 30
// days. Eight copies is also why it stayed wrong: nobody was going to fix the
// same sentence eight times. Now the copy lives once, here.
//
// ── THE COPY IS SHARED WITH MOBILE — DO NOT DRIFT ───────────────────────────
// Titles and CTAs are VERBATIM from mobile's reactivate wall
// (stablepass-mobile `src/app/(gate)/reactivate.tsx`, ENG-573), which branches
// on exactly the same bit. A member who gets kicked out on their phone and then
// opens the laptop must read the same sentence, not two theories about what
// happened to their account.
//
// The only deliberate divergence is the phrase "on the web": mobile has to
// point the member at a different device because subscription is web-only, and
// here we ARE that device. Everything else is character-for-character.
//
// ── GUARDRAILS ──────────────────────────────────────────────────────────────
// * This component is CHROME, not a gate. It decides which SENTENCE to show, it
//   never decides who sees content — callers pass `everSubscribed` already
//   resolved, and entitlement itself comes from `hasAccess()` / the BFF's 402.
// * `everSubscribed` is a BOOLEAN by design. `stripe_customer_id` is resolved
//   server-side and never crosses into client JS (.rx/guardrails.md #1).
// * No copy here states or implies the pass renews — "it never renews on its
//   own" is the point, not a caveat.
// * No cancel / payment-method affordance: the only action is buying days.

/**
 * The two things the wall can be. They are NOT interchangeable, and the
 * difference is the whole bug: telling someone who has paid us that their free
 * trial ended reads as though the payment never registered.
 */
export const WALL_COPY = {
  // No `stripe_customer_id` — never a Stripe customer, so the TRIAL is what ran out.
  trialEnded: {
    title: "Your free trial has ended",
    body: "Your 30 days are up. Buy 30 days of full access to pick up where you left off.",
    cta: "Get full access",
  },
  // Has a `stripe_customer_id` — they have bought before, so the PASS ran out.
  paused: {
    title: "Your access has paused",
    body: "Your 30 days have run out. Buy another 30 days — it never renews on its own.",
    cta: "Buy 30 days",
  },
} as const;

export type WallCopy = (typeof WALL_COPY)[keyof typeof WALL_COPY];

/** The sentence this member should read. The single branch, written once. */
export function accessWallCopy(everSubscribed: boolean): WallCopy {
  return everSubscribed ? WALL_COPY.paused : WALL_COPY.trialEnded;
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
