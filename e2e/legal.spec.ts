import { test, expect, type Page } from "@playwright/test";

/**
 * Legal routes (ENG-590 / W4) — the status codes, and the visual evidence.
 *
 * `test/legal-routes.test.tsx` mocks `notFound()`/`permanentRedirect()` and can
 * therefore only prove INTENT. This spec reads the actual HTTP status of all
 * four slugs plus an unknown one off a running server. 308-vs-307 and
 * 404-vs-redirect are the two things the ticket is most specific about, and
 * neither is observable from a unit test.
 *
 * SCOPE OF THAT CLAIM, precisely: `playwright.config.ts` starts `npm run dev`,
 * so by default this proves ROUTER behaviour, not the prerender. Dev compiles
 * per request and prerenders nothing, so a green run here says nothing about
 * whether the four routes are static — `test/legal-routes.test.tsx` asserts
 * that against `.next/prerender-manifest.json` instead, which is the artifact
 * that actually carries the property.
 *
 * To run this against the real thing (which is how the PR evidence was
 * gathered), start a production server on :3000 first — `reuseExistingServer`
 * means Playwright will attach to it rather than starting dev:
 *
 *     npm run build && npx next start -p 3000 &
 *     npx playwright test e2e/legal.spec.ts
 *
 * No session and no Supabase — the pages are public, which is the entire point.
 * See .rx/fe-harness.md for the harness convention; screenshots land in
 * .rx/review/ and are committed.
 */

const SHOT_DIR = ".rx/review";
const DOCUMENTS = ["privacy", "terms"] as const;
const ALIASES = ["cancellation", "acceptable-use"] as const;

const BANNED = ["This preview shows", "will be supplied by stablepass", "loaded as its own page before launch"];

async function imagesSettled(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      [...document.images]
        .filter((img) => !img.complete)
        .map(
          (img) =>
            new Promise((resolve) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener("error", resolve, { once: true });
            }),
        ),
    ),
  );
}

test.describe("legal routes", () => {
  for (const slug of DOCUMENTS) {
    test(`/legal/${slug} returns 200 and renders the document`, async ({ page }) => {
      const response = await page.goto(`/legal/${slug}`);
      expect(response?.status()).toBe(200);

      const article = page.locator("article");
      await expect(article).toBeVisible();
      await expect(page.locator("h1")).toBeVisible();
      // Sections, not an empty shell.
      expect(await article.locator("h2").count()).toBeGreaterThan(0);
      await expect(article.getByText(/^Last updated \d{1,2} \w+ \d{4}$/)).toBeVisible();

      // It is inside the marketing shell: deep-linked from an app-store listing
      // this must look like the site, not like the member app.
      await expect(page.locator("nav.nav")).toBeVisible();
      await expect(page.locator("footer")).toBeVisible();
    });

    /**
     * The canonical as actually EMITTED, which is the only version that matters
     * once ENG-591 / PR #33 lands a layout-level `alternates.canonical`. Next
     * merges metadata from layout to page, so this asserts the page's override
     * won: exactly one tag, pointing at this document rather than the
     * marketing home it would inherit.
     */
    test(`/legal/${slug} emits exactly one canonical, at the apex`, async ({ page }) => {
      await page.goto(`/legal/${slug}`);

      const canonical = page.locator('link[rel="canonical"]');
      await expect(canonical).toHaveCount(1);
      await expect(canonical).toHaveAttribute("href", `https://stablepass.co/legal/${slug}`);

      const href = await canonical.getAttribute("href");
      expect(href, "inherited the layout's home canonical instead of its own").not.toMatch(
        /^https:\/\/stablepass\.co\/?$/,
      );
    });

    // Decision 4, asserted against the bytes actually served.
    test(`/legal/${slug} ships none of the preview banner`, async ({ page }) => {
      const response = await page.goto(`/legal/${slug}`);
      const html = (await response?.text()) ?? "";
      expect(html.length).toBeGreaterThan(0);
      for (const phrase of BANNED) expect(html).not.toContain(phrase);
    });
  }

  // 308, not 307: these are permanent aliases onto the terms, not a detour.
  for (const slug of ALIASES) {
    test(`/legal/${slug} is a 308 onto the terms`, async ({ page }) => {
      const response = await page.request.get(`/legal/${slug}`, { maxRedirects: 0 });
      expect(response.status()).toBe(308);
      expect(new URL(response.headers()["location"], "http://localhost:3000").pathname).toBe("/legal/terms");
    });

    test(`/legal/${slug} lands on the terms when followed`, async ({ page }) => {
      await page.goto(`/legal/${slug}`);
      expect(new URL(page.url()).pathname).toBe("/legal/terms");
      await expect(page.locator("h1")).toHaveText("Terms & Conditions");
    });
  }

  test("an unknown slug is a genuine 404, not a redirect to the terms", async ({ page }) => {
    for (const path of ["/legal/nonsense", "/legal/privacy-policy", "/legal"]) {
      const response = await page.request.get(path, { maxRedirects: 0 });
      expect(response.status(), `${path} should 404`).toBe(404);
    }
  });
});

/**
 * The defect this ticket exists to fix, verified end to end and — critically —
 * WITHOUT having edited app/start/trial-start-form.tsx, which ENG-571 owns. The
 * form's hrefs are relative, so serving /legal on both hosts is the whole fix.
 */
test.describe("the signup form's legal links", () => {
  test("resolve from /start instead of 404ing", async ({ page }) => {
    await page.goto("/start");

    const links = page.locator(".legal-mini a");
    await expect(links).toHaveCount(2);
    const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute("href")));
    expect(hrefs).toEqual(["/legal/terms", "/legal/privacy"]);

    for (const href of hrefs) {
      const response = await page.request.get(href!, { maxRedirects: 0 });
      expect(response.status(), `${href} still does not resolve`).toBe(200);
    }

    // And it actually navigates, not merely responds.
    await page.getByRole("link", { name: "Privacy Policy" }).click();
    await page.waitForURL("**/legal/privacy");
    await expect(page.locator("h1")).toHaveText("Privacy Policy");
  });
});

/**
 * The client reviews this site on a phone with JS blocked, and a legal page is
 * pure prose — nothing on it may need scripting to be readable.
 */
test.describe("with JavaScript disabled", () => {
  test.use({ javaScriptEnabled: false });

  for (const slug of DOCUMENTS) {
    test(`/legal/${slug} is fully readable`, async ({ page }) => {
      await page.goto(`/legal/${slug}`);

      await expect(page.locator("article h1")).toBeVisible();
      await expect(page.locator("nav.nav")).toBeVisible();
      await expect(page.locator("footer")).toBeVisible();

      const invisible = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".marketing article *")]
          .filter((el) => getComputedStyle(el).opacity === "0" || getComputedStyle(el).display === "none")
          .map((el) => el.tagName),
      );
      expect(invisible).toEqual([]);
    });
  }

  test("the phone view still reads without scripting", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/legal/privacy");
    await page.screenshot({ path: `${SHOT_DIR}/eng-590-privacy-phone-nojs.png`, fullPage: true });
  });
});

test.describe("screenshots", () => {
  for (const slug of DOCUMENTS) {
    test(`captures /legal/${slug} at 1440 and 390`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/legal/${slug}`);
      await imagesSettled(page);
      await page.screenshot({ path: `${SHOT_DIR}/eng-590-${slug}-desktop.png`, fullPage: true });

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/legal/${slug}`);
      await imagesSettled(page);
      await page.screenshot({ path: `${SHOT_DIR}/eng-590-${slug}-phone.png`, fullPage: true });
    });
  }
});
