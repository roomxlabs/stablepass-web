import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("auth heading font", () => {
  it("loads Playfair Display as a next/font face", () => {
    const layout = read("app/layout.tsx");
    expect(layout).toMatch(/Playfair_Display/);
    expect(layout).toMatch(/variable:\s*"--font-playfair"/);
    expect(layout).toMatch(/\$\{playfair\.variable\}/);
  });

  it("sets /signin and /start h1s to Playfair, not Cormorant", () => {
    const css = read("app/globals.css");
    const block = css.match(/\.auth-card h1\s*\{[^}]+\}/);
    expect(block, "missing .auth-card h1 rule").toBeTruthy();
    expect(block![0]).toMatch(/var\(--font-playfair\)/);
    expect(block![0]).toMatch(/font-variant-numeric:\s*lining-nums/);
    expect(block![0]).not.toMatch(/var\(--font-serif\)/);
    expect(block![0]).not.toMatch(/var\(--font-cormorant\)/);
  });
});
