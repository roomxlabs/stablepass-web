import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ENG-831 guardrail: for-sale horses must be filtered out of browse surfaces.
 * Saved and direct profile deep-links stay unfiltered (discovery-only).
 */
describe("ENG-831 shares_for_sale source guards", () => {
  const root = join(__dirname, "..");

  it("Horses browse queries shares_for_sale=false", () => {
    const src = readFileSync(join(root, "app/(member)/horses/horses-grid.tsx"), "utf8");
    expect(src).toMatch(/\.eq\(\s*["']shares_for_sale["']\s*,\s*false\s*\)/);
  });

  it("Trainer profile stable grid queries shares_for_sale=false", () => {
    const src = readFileSync(join(root, "app/(member)/trainers/[id]/page.tsx"), "utf8");
    expect(src).toMatch(/\.eq\(\s*["']shares_for_sale["']\s*,\s*false\s*\)/);
  });

  it("Explore race-day and aside omit for-sale horses", () => {
    const src = readFileSync(join(root, "app/(member)/explore/explore-feed.tsx"), "utf8");
    expect(src).toMatch(/shares_for_sale/);
    expect(src).toMatch(/horse\.shares_for_sale/);
    expect(src).toMatch(/\.eq\(\s*["']shares_for_sale["']\s*,\s*false\s*\)/);
  });

  it("Saved feed does NOT filter shares_for_sale (discovery-only)", () => {
    const src = readFileSync(join(root, "app/(member)/saved/saved-feed.tsx"), "utf8");
    expect(src).not.toMatch(/shares_for_sale/);
  });

  it("Shares CTA uses website_url only — no trainer_contact / owner / price fields", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const card = strip(readFileSync(join(root, "components/post-card.tsx"), "utf8"));
    const feed = strip(readFileSync(join(root, "app/(member)/shares/shares-feed.tsx"), "utf8"));
    expect(card).toMatch(/websiteUrl|website_url/);
    expect(card).toMatch(/Contact trainer/);
    expect(card).not.toMatch(/trainer_contact/);
    expect(feed).not.toMatch(/trainer_contact/);
    expect(feed).not.toMatch(/\bowner\b/);
    expect(card + feed).not.toMatch(/prize_money|odds|bookmaker|price_cents/);
  });
});
