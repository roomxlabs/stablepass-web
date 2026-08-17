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

    /**
     * W3's marquee (ENG-589) clones the WHOLE set to make the loop seamless, so
     * a bare `.tr-card` counts real cards plus clones and stopped being a count
     * of the supplied trainers the moment the static row became a marquee. The
     * clones carry `data-dup`, so excluding them is what keeps this assertion
     * meaning "all nineteen stables render".
     *
     * Counting the raw total instead would pin the current clone factor, and
     * that factor is not a constant: the strip only clones while one set
     * overhangs the window (`setWidth > stripWidth + leadWidth`), and it clones
     * not at all on touch or with scripting off. `:not([data-dup])` is nineteen
     * under every one of those conditions.
     */
    const cards = section.locator(".tr-card:not([data-dup])");
    const clones = section.locator(".tr-card[data-dup]");

    await expect(section).toHaveAttribute("data-trainer-count", "19");
    await expect(cards).toHaveCount(19);
    await expect(cards.first().locator(".tr-nm")).toHaveText("Andrew Bobbin");

    /**
     * And that exclusion is real rather than vacuous — if cloning broke, or a
     * clone stopped carrying `data-dup`, the filter above would quietly match
     * everything and still "pass". So assert the contract it leans on.
     *
     * The strip is definitely looping here, by geometry rather than by a lucky
     * viewport: `.tr-scroll` is capped at `max-width:min(1560px,100%)` while one
     * set of nineteen 222px cards plus 22px gaps measures 4636px, so
     * `setWidth > stripWidth + leadWidth` holds at every width. It is hover
     * capability rather than width that this rests on: on a touch project
     * `selectMode` takes the native-scroller path and never clones at all, and
     * the config declares no such project.
     *
     * The clones mount from a client effect that has to measure first, so this
     * retrying assertion is also what synchronises the raw counts below.
     */
    await expect(clones.first()).toBeAttached();
    const [realCount, cloneCount] = await Promise.all([cards.count(), clones.count()]);
    // Re-pinned AFTER the clones have mounted. The retrying count above is
    // satisfied by the pre-clone frame, so without this the trainer count and
    // the clone contract could be describing two different DOM frames.
    expect(realCount, "the real set stopped being the nineteen supplied trainers").toBe(19);
    expect(cloneCount, "the marquee clones the whole set, not part of it").toBe(realCount);

    // `textContent`, not `innerText`: `.tr-nm` is display:none under
    // `(hover: none)`, where an innerText comparison would quietly compare empty
    // strings to empty strings instead of failing.
    const names = await cards.locator(".tr-nm").allTextContents();
    expect(names, "the trainer captions stopped rendering").toHaveLength(19);
    expect(await clones.locator(".tr-nm").allTextContents()).toEqual(names);

    // Each card actually HAS a photograph, and each photograph resolved. The
    // count is load-bearing rather than belt-and-braces: `evaluateAll` over an
    // empty match returns [], so the broken-image check below passes happily on
    // a page where every <img> has been deleted.
    await expect(cards.locator("img"), "a trainer card rendered no photograph at all").toHaveCount(19);

    // A 404 would silently fall back to the initials disc and still "render 19
    // cards", so resolution is checked as well as presence.
    const broken = await cards.locator("img").evaluateAll((imgs) =>
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

      // Counted through the same `data-dup` contract as the scripted test, so
      // both mean "the nineteen supplied trainers". With no scripting the
      // marquee never runs, so the clone set is expected to be absent entirely —
      // which is the other half of why a hard total would be the wrong assertion.
      await expect(page.locator(".tr-card:not([data-dup])")).toHaveCount(19);
      await expect(page.locator(".tr-card[data-dup]")).toHaveCount(0);

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
