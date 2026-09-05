import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ENG-831 guardrail: for-sale horses must be filtered out of browse surfaces.
 * Saved and direct profile deep-links stay unfiltered (discovery-only).
 *
 * ENG-956 note: R8 reversed the ENG-830/831 SEGREGATION on mobile (for-sale
 * horses now appear in Horses > All, and shares posts in the main feed). Web's
 * browse surfaces have NOT been migrated yet — `horses-grid.tsx`, the trainer
 * profile and `explore-feed.tsx` still filter them out — so the four
 * assertions below still describe web's reality and are left exactly as they
 * were. Bringing web's browse in line with R8 is its own ticket, and its file
 * surface is not this one's; do not "fix" these here.
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

  /**
   * ENG-956 replaced this block. It used to read `shares-feed.tsx` (deleted:
   * /shares is no longer a feed) and to REQUIRE `"Contact trainer"` in the post
   * card — the exact CTA R8 killed (ENG-862 on mobile), so the old assertion
   * now asserts the bug. The guardrail it protects is unchanged: whatever the
   * Shares surface links out to, the only field it may read is the trainer's
   * public `website_url` — never a contact row, an owner, or a price.
   */
  it("Shares list links out via website_url only — no trainer_contact / owner / price fields", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const list = strip(readFileSync(join(root, "app/(member)/shares/shares-list.tsx"), "utf8"));

    // Positive first — a file that failed to load would pass every negative
    // assertion below vacuously.
    expect(list).toMatch(/websiteUrl|website_url/);
    expect(list).toMatch(/shares_for_sale/);

    expect(list).not.toMatch(/trainer_contact/);
    // Same shape as the global guard in `owner-pii-guard.test.ts`: the regex is
    // untouched, and only the one signed-off empty-state sentence is scrubbed
    // out first — so any `ownership*` IDENTITY read here still fails.
    const scrubbed = list.split("Horses with ownership shares for sale will show up here.").join(" ");
    expect(scrubbed).not.toMatch(/\bowner/i);
    expect(list).not.toMatch(/prize_money|odds|bookmaker|price_cents/);
  });

  it("the post card no longer carries the shares Contact-trainer CTA (ENG-956)", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const card = strip(readFileSync(join(root, "components/post-card.tsx"), "utf8"));

    // Positive anchor: the card itself still exists and still renders.
    expect(card).toMatch(/export function PostCard/);

    expect(card).not.toMatch(/Contact trainer/);
    expect(card).not.toMatch(/variant\s*=\s*["']shares["']/);
    expect(card).not.toMatch(/trainer_contact/);
    // Carried over from the block this replaced, which applied it to
    // `card + feed`. `horse.prize_money_cents` is a REAL column, so dropping
    // the card half would leave it — and bare `odds`/`price_cents` — guarded
    // nowhere (`owner-pii-guard.test.ts` only covers bookmaker vocabulary).
    expect(card).not.toMatch(/prize_money|odds|bookmaker|price_cents/);
  });

  it("the deleted /api/feed/shares route stays deleted", () => {
    expect(existsSync(join(root, "app/api/feed/shares/route.ts"))).toBe(false);
    expect(existsSync(join(root, "app/(member)/shares/shares-feed.tsx"))).toBe(false);
  });
});
