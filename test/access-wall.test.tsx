import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { AccessWall, WALL_COPY, accessWallCopy } from "@/components/access-wall";

// ENG-585. The wall used to be eight hardcoded copies of "Your trial has ended.
// Reactivate your subscription to …", shown to everyone — including a member
// who had converted to a paid pass and PAID for it.
//
// ENG-1008 then fixed the OTHER half of the same sentence. ENG-999 retired the
// free trial, so the never-paid branch was telling a brand-new account that
// something it had never been offered had run out. Both branches are asserted
// here, in both directions: each must say its own thing AND must not say the
// other's.

describe("AccessWall — the copy branches on whether the member ever paid", () => {
  it("a member who has NEVER paid is told they do not have a subscription yet", () => {
    render(<AccessWall everSubscribed={false} />);
    expect(screen.getByText("You don't have a subscription yet")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Subscribe to see every update from the stables you follow. It renews monthly and you can cancel any time.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get full access" })).toHaveAttribute("href", "/checkout");
    // ENG-1008: they never had one, so nothing of theirs can have ended.
    expect(screen.queryByText(/trial/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Your access has paused")).not.toBeInTheDocument();
  });

  it("a member who HAS paid is told their access paused, not that they are new", () => {
    render(<AccessWall everSubscribed />);
    expect(screen.getByText("Your access has paused")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Restart my subscription" })).toHaveAttribute("href", "/checkout");
    // The original regression: this is the sentence the DRI's paying member saw.
    expect(screen.queryByText(/trial/i)).not.toBeInTheDocument();
    // …and the new one: a returning member is not a first-time buyer.
    expect(screen.queryByText("You don't have a subscription yet")).not.toBeInTheDocument();
  });

  it("renders the onboarding hero skin without changing the words", () => {
    render(<AccessWall everSubscribed variant="hero" />);
    expect(screen.getByRole("heading", { name: "Your access has paused" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Restart my subscription" })).toBeInTheDocument();
  });

  it("the hero skin carries the never-subscribed words too", () => {
    render(<AccessWall everSubscribed={false} variant="hero" />);
    expect(screen.getByRole("heading", { name: "You don't have a subscription yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get full access" })).toHaveAttribute("href", "/checkout");
  });

  it("accessWallCopy is the single branch both variants read", () => {
    expect(accessWallCopy(true)).toBe(WALL_COPY.paused);
    expect(accessWallCopy(false)).toBe(WALL_COPY.neverSubscribed);
  });

  it("the two branches are never the same words", () => {
    expect(WALL_COPY.neverSubscribed.title).not.toBe(WALL_COPY.paused.title);
    expect(WALL_COPY.neverSubscribed.body).not.toBe(WALL_COPY.paused.body);
  });
});

// ── Cross-platform copy lock ────────────────────────────────────────────────
// ENG-573 shipped these exact titles and CTAs on mobile
// (stablepass-mobile src/app/(gate)/reactivate.tsx). A member kicked out on
// their phone who then opens the laptop must read the SAME sentence. If someone
// reworks this copy, they have to rework mobile in the same breath — that is
// what this test is for.
//
// ENG-1008 moved the never-subscribed title ahead of mobile deliberately: the
// web sentence was factually false for every reader, and ENG-1004 is the mobile
// slice of the same retirement. What must NOT cross over is the /checkout CTA
// target — the iOS app carries no pointer to an external purchase (App Store
// 3.1.3(a)) — so any parity is on WORDS, never on the link.
//
// The block is therefore no longer named for that parity. It never verified it
// anyway: pinning a literal in THIS repo cannot observe the other one, so this
// is a change-detector on our own copy — which is worth having, but it should
// not claim to be a cross-repo guarantee. ENG-1004 owns the mobile wording.
describe("wall copy — the pinned strings", () => {
  it("pins the titles and CTAs verbatim", () => {
    expect(WALL_COPY.neverSubscribed.title).toBe("You don't have a subscription yet");
    expect(WALL_COPY.neverSubscribed.cta).toBe("Get full access");
    expect(WALL_COPY.paused.title).toBe("Your access has paused");
    expect(WALL_COPY.paused.cta).toBe("Restart my subscription");
  });

  // INVERTED BY ENG-1022, and that inversion is the whole point of this test.
  //
  // It used to assert the copy never implies renewal, which was correct for the
  // 30-day non-renewing pass. ENG-1028 then shipped monthly auto-renewal and
  // nobody came back here: both branches went on saying "it never renews on its
  // own" while /checkout, one click later, said "Your subscription renews
  // monthly until you cancel". Whichever a member read second, one of them was
  // false — and telling an Australian consumer a purchase does not auto-renew
  // before enrolling them in one is a misrepresentation, not a copy nit.
  //
  // So the assertion now runs the other way, and the DENIALS are banned
  // outright: a future edit that reintroduces "never renews" turns this red
  // instead of shipping.
  it("says the subscription renews, and never denies it", () => {
    for (const copy of Object.values(WALL_COPY)) {
      const text = `${copy.title} ${copy.body} ${copy.cta}`;
      expect(text).toMatch(/\brenews?\b/i);
      expect(text).not.toMatch(/\bnever renews\b/i);
      expect(text).not.toMatch(/\bdoes ?n[o']?t (?:auto-?)?renew/i);
      expect(text).not.toMatch(/\bon its own\b/i);
    }
  });

  // The other half of the same promise. If the copy says it renews, it must
  // also say how to stop it — an auto-renewing charge advertised without the
  // exit is the part a consumer regulator cares about.
  it("tells the member they can cancel", () => {
    for (const copy of Object.values(WALL_COPY)) {
      expect(`${copy.body}`).toMatch(/\bcancel\b/i);
    }
  });

  // ENG-1008 guardrail. A pass has two prices and which one a member is offered
  // is decided server-side from their promo counter (ENG-1001), so ANY amount
  // written into this static table is wrong for a large share of the audience.
  // "30 days" is a duration and stays; a currency amount may never appear.
  it("quotes no price", () => {
    for (const copy of Object.values(WALL_COPY)) {
      const text = `${copy.title} ${copy.body} ${copy.cta}`;
      expect(text).not.toMatch(/\$/);
      expect(text).not.toMatch(/\b(?:AUD|aud)\b/);
      expect(text).not.toMatch(/\b\d+(?:\.\d{2})?\s*(?:dollars?|bucks)\b/i);
      expect(text).not.toMatch(/\bper (?:month|week|year)\b/i);
    }
  });

  // The never-subscribed branch must describe NOT HAVING BOUGHT, which is a
  // different claim from "your thing expired". Pin the shape, not just the
  // string, so a future reword cannot quietly reintroduce an expiry story to
  // someone who has no history to expire.
  it("tells a never-subscribed member about subscribing, not about expiry", () => {
    const { title, body } = WALL_COPY.neverSubscribed;
    const text = `${title} ${body}`;
    expect(text).toMatch(/\bsubscri(?:be|ption)\b/i);
    // Over the WHOLE sentence, not just the title: "Subscribe — your access
    // ended" would otherwise sail through a title-only check.
    expect(text).not.toMatch(/\b(?:ended|expired|run out|ran out)\b/i);
  });
});

// ── The guardrail test: "Reactivate" stays out of the copy ──────────────────
// Originally this banned "Reactivate" because nothing renewed, so there was
// nothing to reactivate. ENG-1022 brought auto-renewal back and that rationale
// is gone — a paused subscription IS a thing you restart.
//
// The ban stands anyway, now for a plainer reason: ONE verb for one action. The
// wall says "Restart my subscription" and /account says the same, because the
// word crept into EIGHT screens the first time precisely by being copy-pasted
// and two synonyms for the same button is how that starts again. A grep guard
// rather than a per-screen assertion, for the same reason.
//
// If someone deliberately standardises on "Reactivate", this test is the place
// to make that decision — not a file to route around.
function tsxFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFilesUnder(full));
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("no user-facing 'Reactivate' remains", () => {
  it("does not appear in any rendered string in app/ or components/", () => {
    const root = join(__dirname, "..");
    const files = [...tsxFilesUnder(join(root, "app")), ...tsxFilesUnder(join(root, "components"))];
    expect(files.length).toBeGreaterThan(10); // the walk actually found the tree

    const offenders: string[] = [];
    for (const file of files) {
      for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
        // Comments may still discuss the old wording (and the history matters);
        // rendered copy may not.
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
        if (/reactivate/i.test(code)) offenders.push(`${file.slice(root.length + 1)}:${i + 1}: ${code}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
