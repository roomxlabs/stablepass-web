import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The wordmark is a CSS mask, so there is no <img> to assert on — the asset plus
// the stylesheet rules ARE the contract. Guards the regression this replaced: the
// brand rendered as a Cormorant text node ("stablepass.") that was neither the
// real mark nor the right weight.
const read = (p: string) => readFileSync(resolve(process.cwd(), p));
const css = () => readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function png(buf: Buffer) {
  expect(buf.subarray(0, 8)).toEqual(PNG_MAGIC);
  // IHDR: width/height big-endian u32, then bit depth (24) and colour type (25).
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colorType: buf[25],
  };
}

describe("brand mask assets", () => {
  it("ships the wordmark as a greyscale+alpha PNG so currentColor can paint it", () => {
    const meta = png(read("public/brand/wordmark.png"));
    expect(meta.height).toBe(120);
    // Colour type 4 = greyscale + alpha. The alpha channel carries ink coverage;
    // a type-6 RGBA or type-2 RGB export would drag the source colour along and
    // defeat recolouring.
    expect(meta.colorType).toBe(4);
  });

  it("ships the square S. mark for the collapsed rail", () => {
    const meta = png(read("public/brand/mark.png"));
    expect(meta.height).toBe(120);
    expect(meta.colorType).toBe(4);
    // Near-square: the rail is 72px wide, so a wide mark would not fit.
    expect(meta.width / meta.height).toBeLessThan(1.2);
  });

  it("keeps the declared aspect-ratios matching the real assets", () => {
    const sheet = css();
    const word = png(read("public/brand/wordmark.png"));
    const mark = png(read("public/brand/mark.png"));

    const declared = (selectorBlock: string) => {
      const m = selectorBlock.match(/aspect-ratio:\s*(\d+)\s*\/\s*(\d+)/);
      expect(m).toBeTruthy();
      return Number(m![1]) / Number(m![2]);
    };
    // Match the block that actually declares the ratio — .wordmark and .brandmark
    // also share an earlier rule for the mask plumbing, which carries none.
    const block = (name: string) => {
      const m = sheet.match(new RegExp(`\\.${name}\\s*\\{[^}]*aspect-ratio[^}]*\\}`));
      expect(m, `missing .${name} aspect-ratio rule`).toBeTruthy();
      return m![0];
    };

    // Declared ratio must match the shipped pixels, or `contain` letterboxes the
    // mask inside its box and the mark drifts off its baseline.
    expect(declared(block("wordmark"))).toBeCloseTo(word.width / word.height, 1);
    expect(declared(block("brandmark"))).toBeCloseTo(mark.width / mark.height, 1);
  });
});

describe("shell responsive stages", () => {
  it("drops the right rail on the content box, not the raw viewport", () => {
    const sheet = css();
    // The old query fired at 980px of VIEWPORT while constraining .main, which is
    // viewport minus the sidebar — so iPad landscape (1024px) never triggered it.
    expect(sheet).not.toMatch(/@media\s*\(max-width:\s*980px\)/);
    expect(sheet).toMatch(/@media\s*\(max-width:\s*1099px\)/);
  });

  it("declares a tablet icon rail between the drawer and the full sidebar", () => {
    expect(css()).toMatch(/@media\s*\(min-width:\s*900px\)\s*and\s*\(max-width:\s*1279px\)/);
  });

  it("collapses the rail to 72px and swaps the wordmark for the square mark", () => {
    const sheet = css();
    const rail = sheet.match(
      /@media\s*\(min-width:\s*900px\)\s*and\s*\(max-width:\s*1279px\)\s*\{[\s\S]*?\n\}/,
    );
    expect(rail).toBeTruthy();
    expect(rail![0]).toMatch(/grid-template-columns:\s*72px\s+1fr/);
    expect(rail![0]).toMatch(/\.sidebar-wordmark\s*\{\s*display:\s*none/);
    expect(rail![0]).toMatch(/\.sidebar-brandmark\s*\{\s*display:\s*block/);
  });

  it("turns the sidebar into an off-canvas drawer below the rail", () => {
    const sheet = css();
    const phone = sheet.match(/@media\s*\(max-width:\s*899px\)\s*\{[\s\S]*?\n\}/);
    expect(phone).toBeTruthy();
    expect(phone![0]).toMatch(/position:\s*fixed/);
    expect(phone![0]).toMatch(/transform:\s*translateX\(-100%\)/);
    expect(phone![0]).toMatch(/\.nav-toggle\s*\{\s*display:\s*inline-flex/);
  });

  it("hides the drawer chrome outside the phone stage", () => {
    const sheet = css();
    expect(sheet).toMatch(/\.nav-toggle\s*\{\s*display:\s*none/);
    expect(sheet).toMatch(/\.sidebar-backdrop\s*\{\s*display:\s*none/);
  });
});
