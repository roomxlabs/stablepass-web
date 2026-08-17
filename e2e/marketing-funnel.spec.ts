import { test, expect } from "@playwright/test";

/**
 * Marketing funnel + artefact sweep (ENG-600).
 *
 * Two things this proves that no component test can:
 *
 *  1. A visitor can actually LEAVE the marketing site toward the product. Before
 *     this ticket every conversion CTA was an in-page anchor and the funnel was a
 *     loop — hero to pricing, pricing back to hero — with no sign-in anywhere. A
 *     unit test asserting one component's href would not have caught that, because
 *     each individual anchor was "correct" against the mockup.
 *
 *  2. The shipped bytes carry no mockup review artefacts. Asserted against the
 *     served HTML and the served stylesheets rather than the .next tree, because
 *     the tree is full of false positives: the checkout path contains the string
 *     "RX Labs" (the workspace directory is `RX Labs Australia`), and source maps
 *     legitimately carry the explanatory comments that name what was removed.
 *
 * Public and static, so no session and no Supabase — same as the W1 spec.
 */

// Every artefact must be absent from what a browser receives. `Race Day` is NOT
// in this list on purpose: the hero ticker says "RACE DAY ALERTS" and the copy
// says "watch race day build up", both approved. Banning the string outright
// would fail on real content.
const ARTEFACTS = [
  "Concept B",
  "RX Labs",
  // The reviewer note that disclosed the admin portal to subscribers.
  "Photographs and locations are the real supplied trainer details",
  "admin portal",
];

test.describe("marketing funnel (ENG-600)", () => {
  test("the nav offers both a way in and a way back", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("a.nav-cta")).toHaveAttribute("href", "/start");
    await expect(page.locator("a.nav-signin")).toHaveAttribute("href", "/signin");
    await expect(page.locator("a.nav-signin")).toBeVisible();
  });

  test("sign in survives the breakpoint that hides the section links", async ({ page }) => {
    // `.nav-links{display:none}` at <=880px. If sign in had been left inside that
    // group it would vanish on exactly the devices most likely to need it.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.locator("a.nav-signin")).toBeVisible();
    await expect(page.locator("a.nav-cta")).toBeVisible();

    // And neither label may wrap or push the page sideways.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow, "the nav pushed the page into horizontal scroll").toBe(false);
  });

  test("no conversion CTA is still an in-page anchor", async ({ page }) => {
    await page.goto("/");
    const hrefs = await page
      .locator("a.cta-trial, a.cta-join, a.nav-cta")
      .evaluateAll((els) => els.map((e) => e.getAttribute("href")));

    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every((h) => h === "/start")).toBe(true);
  });

  test("the trial CTA actually reaches the signup page", async ({ page }) => {
    // The end-to-end claim. On localhost there is no host split, so this lands
    // directly; in production middleware 307s the apex onto the app host first.
    await page.goto("/");
    await page.locator("a.cta-trial").first().click();
    await page.waitForURL("**/start");
    expect(new URL(page.url()).pathname).toBe("/start");
  });

  test("ships no mockup review artefact, in the copy or the stylesheet", async ({ page }) => {
    await page.goto("/");

    // Asserted against RENDERED TEXT, not raw HTML. These artefacts are copy, so
    // copy is the right surface — and raw HTML gives a false positive in dev,
    // where turbopack emits chunk URLs built from the absolute project path. The
    // repository lives under a directory literally named "RX Labs Australia", so
    // a raw-HTML sweep for "RX Labs" fails on the file path rather than the
    // footer stamp. `href="#"` is markup rather than copy and has its own test.
    const text = await page.locator("body").innerText();
    for (const artefact of ARTEFACTS) {
      expect(text, `the page still reads "${artefact}"`).not.toContain(artefact);
    }

    const hrefs = await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll((links) => links.map((l) => (l as HTMLLinkElement).href));
    for (const href of hrefs) {
      // Comments are stripped first for the same reason the HTML check reads
      // rendered text: in dev the sheet ends with a sourceMappingURL comment
      // carrying the absolute project path, which contains "RX Labs". Only
      // declarations can put an artefact in front of a user anyway — via
      // `content:` — and those survive the strip.
      const css = (await (await page.request.get(href)).text()).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const artefact of ARTEFACTS) {
        expect(css, `${href} still carries "${artefact}"`).not.toContain(artefact);
      }
    }
  });

  test("no link goes nowhere", async ({ page }) => {
    // The three footer social icons were `href="#"` with no accounts behind them.
    await page.goto("/");
    await expect(page.locator('a[href="#"]')).toHaveCount(0);
  });
});
