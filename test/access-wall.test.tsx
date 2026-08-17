import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { AccessWall, WALL_COPY, accessWallCopy } from "@/components/access-wall";

// ENG-585. The wall used to be eight hardcoded copies of "Your trial has ended.
// Reactivate your subscription to …", shown to everyone — including a member
// who had converted to a paid pass and PAID for it.

describe("AccessWall — the copy branches on whether the member ever paid", () => {
  it("a member who has NEVER paid is told their TRIAL ended", () => {
    render(<AccessWall everSubscribed={false} />);
    expect(screen.getByText("Your free trial has ended")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get full access" })).toHaveAttribute("href", "/checkout");
  });

  it("a member who HAS paid is never told their trial ended", () => {
    render(<AccessWall everSubscribed />);
    expect(screen.getByText("Your access has paused")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy 30 days" })).toHaveAttribute("href", "/checkout");
    // The actual regression: this is the sentence the DRI's paying member saw.
    expect(screen.queryByText(/trial has ended/i)).not.toBeInTheDocument();
  });

  it("renders the onboarding hero skin without changing the words", () => {
    render(<AccessWall everSubscribed variant="hero" />);
    expect(screen.getByRole("heading", { name: "Your access has paused" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy 30 days" })).toBeInTheDocument();
  });

  it("accessWallCopy is the single branch both variants read", () => {
    expect(accessWallCopy(true)).toBe(WALL_COPY.paused);
    expect(accessWallCopy(false)).toBe(WALL_COPY.trialEnded);
  });
});

// ── Cross-platform copy lock ────────────────────────────────────────────────
// ENG-573 shipped these exact titles and CTAs on mobile
// (stablepass-mobile src/app/(gate)/reactivate.tsx). A member kicked out on
// their phone who then opens the laptop must read the SAME sentence. If someone
// reworks this copy, they have to rework mobile in the same breath — that is
// what this test is for.
describe("web wall copy matches mobile (ENG-573)", () => {
  it("pins the titles and CTAs verbatim", () => {
    expect(WALL_COPY.trialEnded.title).toBe("Your free trial has ended");
    expect(WALL_COPY.trialEnded.cta).toBe("Get full access");
    expect(WALL_COPY.paused.title).toBe("Your access has paused");
    expect(WALL_COPY.paused.cta).toBe("Buy 30 days");
  });

  it("never states or implies the pass renews", () => {
    for (const copy of Object.values(WALL_COPY)) {
      const text = `${copy.title} ${copy.body} ${copy.cta}`;
      expect(text).not.toMatch(/\brenews\b(?!\s+on its own)/i);
      expect(text).not.toMatch(/auto-?renew/i);
      expect(text).not.toMatch(/subscription will continue/i);
    }
  });
});

// ── The guardrail test: "Reactivate" is retired ─────────────────────────────
// This epic deleted the cancel and payment-method routes because there is
// nothing to cancel and nothing to reactivate — the pass ends and you buy
// another 30 days. "Reactivate" is vocabulary from the auto-renewing model that
// no longer exists. A grep guard rather than a per-screen assertion, because the
// word crept into EIGHT screens the first time precisely by being copy-pasted.
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
