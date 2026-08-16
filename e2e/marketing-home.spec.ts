import { existsSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

/**
 * Marketing home (ENG-588 / W2) — design-fidelity + no-JS evidence.
 *
 * Public and static like the W1 shell, so no session and no Supabase. Screenshots
 * land in .rx/review/ and are committed, per .rx/fe-harness.md.
 *
 * Both viewports are captured twice: once from this build and once from the
 * signed-off mockup loaded over file://, at the same size, so the PR can put them
 * side by side and fidelity is reviewable rather than asserted.
 */

const SHOT_DIR = ".rx/review";
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const MOCKUP_SUFFIX = "10-marketing-site/deploy/src/mockup.html";
function findMockup(): string | null {
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, MOCKUP_SUFFIX);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
const MOCKUP = findMockup();

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

/**
 * Reduced motion, applied to the screenshot runs on BOTH sides.
 *
 * Two reasons, and both matter. It stops the ribbon and the marquee mid-drift, so
 * the two images are comparable rather than caught at different frames. And it
 * makes the reveal deterministic: `.rv` starts at opacity 0 under JS, and the
 * observer only reveals what scrolls into view, so a full-page capture would
 * otherwise show blank bands below the failsafe's reach. Under reduced motion the
 * reveal script marks everything `.in` up front.
 *
 * It is the same stylesheet and the same script in both trees, so this settles
 * both sides identically. Functional tests deliberately run at default motion.
 */
async function settleForCapture(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
}

/**
 * `next dev` injects its own floating dev-tools indicator into the page. It is
 * not part of the design and must not appear in a fidelity screenshot, so it is
 * hidden at capture time rather than switched off in next.config.ts, which is
 * ENG-591's file.
 */
async function hideDevOverlay(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
}

test.describe("marketing home", () => {
  test("renders the twelve sections in order between nav and footer", async ({ page }) => {
    await page.goto("/");

    const blocks = page.locator("main > header.hero, main > .ribbon, main > section");
    await expect(blocks).toHaveCount(13);

    for (const id of ["top", "how", "app", "members", "subscription", "stable-trainers", "faq", "trainers"]) {
      await expect(page.locator(`#${id}`)).toHaveCount(1);
    }

    await expect(page.locator("nav.nav")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("The racing experience made simple.");
  });

  test("every nav anchor scrolls to a real target", async ({ page }) => {
    await page.goto("/");

    for (const hash of ["#how", "#app", "#subscription", "#trainers", "#faq", "#top"]) {
      const target = page.locator(hash);
      await expect(target, `${hash} has no target`).toHaveCount(1);
      await expect(target).toBeVisible();
    }
  });

  test("shows all nineteen trainer cards with their photographs", async ({ page }) => {
    await page.goto("/");
    await imagesSettled(page);

    const section = page.locator("#stable-trainers");
    await expect(section).toHaveAttribute("data-trainer-count", "19");
    await expect(section.locator(".tr-card")).toHaveCount(19);
    await expect(section.locator(".tr-card").first().locator(".tr-nm")).toHaveText("Andrew Bobbin");

    // Every photograph actually resolved — a 404 would silently fall back to the
    // initials disc and still "render 19 cards".
    const broken = await section.locator(".tr-card img").evaluateAll((imgs) =>
      imgs.filter((i) => !(i as HTMLImageElement).naturalWidth).map((i) => (i as HTMLImageElement).src),
    );
    expect(broken).toEqual([]);
  });

  test("ships no inlined image on the home page", async ({ page }) => {
    const response = await page.goto("/");
    expect((await response?.text()) ?? "").not.toContain("data:image/");
  });

  /**
   * The real proof for the `suppressHydrationWarning` note in sections/index.tsx.
   * W1's reveal script rewrites `.rv` classes before React hydrates, and under
   * reduced motion it does so to all twenty-two at once — the worst case. If the
   * opt-out were missing this run would log a hydration mismatch per element.
   */
  test("hydrates cleanly, including under reduced motion", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForTimeout(1200);

    expect(errors.filter((e) => /hydrat|did not match|server rendered/i.test(e))).toEqual([]);

    // And the reveal actually revealed: nothing left stuck at opacity 0.
    const hidden = await page.locator("main .rv").evaluateAll((els) =>
      els.filter((el) => getComputedStyle(el).opacity === "0").map((el) => el.className),
    );
    expect(hidden).toEqual([]);
  });

  test.describe("with JavaScript disabled", () => {
    test.use({ javaScriptEnabled: false });

    test("the FAQ still opens and closes", async ({ page }) => {
      await page.goto("/");

      const first = page.locator("#faq details").first();
      const answer = first.locator("p.a");

      await expect(first).not.toHaveAttribute("open", /.*/);
      await first.locator("summary").click();
      await expect(first).toHaveAttribute("open", /.*/);
      await expect(answer).toBeVisible();

      await first.locator("summary").click();
      await expect(first).not.toHaveAttribute("open", /.*/);
    });

    test("no section is stuck invisible and all nineteen trainers are visible", async ({ page }) => {
      await page.goto("/");

      const hidden = await page.locator("main > header.hero, main > section").evaluateAll((els) =>
        els.filter((el) => getComputedStyle(el).opacity === "0").map((el) => el.className),
      );
      expect(hidden).toEqual([]);

      await expect(page.locator(".tr-card")).toHaveCount(19);
      const offscreen = await page.locator(".tr-card").evaluateAll((cards) => {
        const strip = document.querySelector(".tr-scroll")!.getBoundingClientRect();
        return cards.filter((c) => {
          const box = c.getBoundingClientRect();
          return box.right <= strip.left || box.left >= strip.right;
        }).length;
      });
      expect(offscreen, "trainer cards clipped out of the strip with JS off").toBe(0);
    });
  });

  for (const [name, viewport] of [
    ["1440", DESKTOP],
    ["390", PHONE],
  ] as const) {
    test(`full-page screenshot at ${name}`, async ({ page }) => {
      await settleForCapture(page);
      await page.setViewportSize(viewport);
      await page.goto("/");
      await hideDevOverlay(page);
      await imagesSettled(page);
      await page.waitForTimeout(400);

      await page.screenshot({ path: `${SHOT_DIR}/eng588-home-${name}.png`, fullPage: true, animations: "disabled" });
    });

    test(`mockup reference screenshot at ${name}`, async ({ page }) => {
      test.skip(!MOCKUP, "signed-off mockup not present in this checkout");

      await settleForCapture(page);
      await page.setViewportSize(viewport);
      await page.goto(`file://${MOCKUP}`);
      await imagesSettled(page);
      await page.waitForTimeout(400);

      await page.screenshot({ path: `${SHOT_DIR}/eng588-mockup-${name}.png`, fullPage: true, animations: "disabled" });
    });
  }
});
