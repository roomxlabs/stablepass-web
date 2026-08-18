// ENG-612 — the media ground is asserted from the stylesheet source, not
// assumed. jsdom does not resolve custom properties or apply a real stylesheet,
// so a render-level `toHaveStyle` here would pass vacuously; reading the CSS is
// what actually pins the colour.
//
// Design source: 06-stage1-design/mockups/web/style.css, round 5 block
// (17 Aug 2026), rows 1 and 2 — "Real aspect, neutral ground".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GLOBALS = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");
const MARKETING = readFileSync(join(process.cwd(), "app/(marketing)/marketing.css"), "utf8");

/** The single base rule for the post media box (not the descendant rules). */
const BASE_RULE = /^\.post-media-web \{[^}]*\}/m;

describe("post media ground (ENG-612 rows 1 and 2)", () => {
  it("defines the neutral --media-ground token as the design source specifies", () => {
    expect(GLOBALS).toMatch(/--media-ground:\s*#1A1A1A;/i);
  });

  it("paints the unpainted media ground with --media-ground", () => {
    const rule = GLOBALS.match(BASE_RULE)?.[0];
    expect(rule).toBeDefined();
    expect(rule).toContain("background: var(--media-ground)");
  });

  // The "green screen" the client reported: brand green behind media reads as
  // chrome the app drew, because the box is edge to edge.
  it("leaves no --brand-green-dark behind post media", () => {
    const rule = GLOBALS.match(BASE_RULE)?.[0];
    expect(rule).toBeDefined();
    expect(rule).not.toContain("--brand-green-dark");
  });

  // Scope decision 2: the buckets stay so the box is never zero-height before
  // the inline `aspect-ratio` applies.
  it("keeps the bucket classes as the CSS fallback", () => {
    const rule = GLOBALS.match(BASE_RULE)?.[0];
    expect(rule).toContain("aspect-ratio: 16/9");
    expect(GLOBALS).toMatch(/\.post-media-web\.tall\s*\{\s*aspect-ratio:\s*4\/5;\s*\}/);
    expect(GLOBALS).toMatch(/\.post-media-web\.square\s*\{\s*aspect-ratio:\s*1\/1;\s*\}/);
  });

  // The base-rule checks above would not notice brand green creeping back in
  // through a DESCENDANT rule, which is how this regresses in practice. Scans
  // every `.post-media-web*` rule instead.
  //
  // Deliberately scoped to `background`: `.post-media-web .media-play` legitimately
  // uses `--brand-green-dark` as its `color` (the play glyph on a white pill),
  // which is foreground chrome, not the ground behind unpainted media.
  it("leaves no brand-green BACKGROUND on any post-media rule, not just the base", () => {
    const rules = GLOBALS.match(/\.post-media-web[^{]*\{[^}]*\}/g) ?? [];
    expect(rules.length).toBeGreaterThan(0);

    const offenders = rules.filter((rule) =>
      /background(-color)?:[^;}]*var\(--brand-green/.test(rule),
    );
    expect(offenders).toEqual([]);
  });

  // Guardrail: marketing.css is a separate, frozen design system diffed
  // rule-for-rule by test/marketing-shell.test.tsx. A globals.css edit must not
  // leak into it.
  it("does not leak the member token into the frozen marketing stylesheet", () => {
    expect(MARKETING).not.toContain("--media-ground");
    expect(MARKETING).not.toContain("post-media-web");
  });
});
