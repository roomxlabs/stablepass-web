import { existsSync } from "node:fs";
import path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import {
  seedMarketingTrainers,
  SEEDED_TRAINERS,
  SEEDED_TRAINER_WITH_PHOTO,
  SEEDED_TRAINER_SPARSE,
  RETIRED_PLACEHOLDER_STRINGS,
} from "./support/marketing-trainers";

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
  // ENG-730: the strip now reads live from Supabase, so any assertion that
  // touches #stable-trainers needs a seeded roster. Runs per-worker; seeding is
  // idempotent (upsert by slug), so re-running it for each worker is harmless.
  let seeded = false;
  test.beforeAll(async () => {
    seeded = await seedMarketingTrainers();
  });
  // No teardown on purpose. Playwright runs fullyParallel, and unpublishing the
  // roster while another worker is mid-test is precisely the race that made this
  // suite look like it needed --workers=1. Seeding is additive and idempotent;
  // see e2e/support/marketing-trainers.ts.

  test("renders the twelve sections in order between nav and footer", async ({ page }) => {
    test.skip(!seeded, "local Supabase has no public_trainer view — cannot seed the marketing roster");

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

  test("every nav anchor a visitor can click scrolls to a real, visible target", async ({ page }) => {
    await page.goto("/");

    // ENG-729: derived from what is actually CLICKABLE rather than a fixed list.
    // In waitlist mode the Subscription entry and the section it targets are
    // both hidden, and a hardcoded list would either fail on a dead anchor or
    // have to special-case it by name and stop testing the real invariant —
    // which is that a link a visitor can see always leads somewhere they can
    // see. That holds in every mode, so this needs no revisit at switch-back.
    const hashes = await page
      .locator('nav.nav a[href^="#"]')
      .evaluateAll((els) =>
        els
          .filter((el) => (el as HTMLElement).offsetParent !== null)
          .map((el) => el.getAttribute("href")!),
      );

    expect(hashes.length, "no clickable in-page nav anchors at all").toBeGreaterThan(0);
    for (const hash of [...new Set(hashes)]) {
      const target = page.locator(hash);
      await expect(target, `${hash} has no target`).toHaveCount(1);
      await expect(target, `${hash} is offered but its target is hidden`).toBeVisible();
    }
  });

  test("hides the Subscription anchor and the section it points at together", async ({ page }) => {
    // The other half of the test above: pre-launch neither may be reachable, and
    // both must still EXIST so the launch switch-back stays a one-line change.
    await page.goto("/");

    const anchor = page.locator('nav.nav a[href="#subscription"]');
    await expect(anchor).toHaveCount(1);
    await expect(anchor).toBeHidden();
    await expect(page.locator("#subscription")).toHaveCount(1);
    await expect(page.locator("#subscription")).toBeHidden();
  });

  test("shows every seeded trainer card, each with a photograph or an initials disc", async ({ page }) => {
    test.skip(!seeded, "local Supabase has no public_trainer view — cannot seed the marketing roster");

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

    await expect(section).toHaveAttribute("data-trainer-count", String(SEEDED_TRAINERS.length));
    await expect(cards).toHaveCount(SEEDED_TRAINERS.length);
    // The attribute and the actually-rendered card count must agree — that
    // cross-check is the valuable part, not just two numbers that happen to
    // both come from the seed on paper.
    expect(await section.getAttribute("data-trainer-count")).toBe(String(await cards.count()));

    await expect(cards.first().locator(".tr-nm")).not.toBeEmpty();

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
    expect(realCount, "the real set stopped being the seeded trainers").toBe(SEEDED_TRAINERS.length);
    expect(cloneCount, "the marquee clones the whole set, not part of it").toBe(realCount);

    // `textContent`, not `innerText`: `.tr-nm` is display:none under
    // `(hover: none)`, where an innerText comparison would quietly compare empty
    // strings to empty strings instead of failing.
    const names = await cards.locator(".tr-nm").allTextContents();
    expect(names, "the trainer captions stopped rendering").toHaveLength(SEEDED_TRAINERS.length);
    // Order-insensitive: `readPublicTrainers` sorts alphabetically, the seed
    // array does not, so this is the set of seeded names, not the sequence.
    expect(new Set(names)).toEqual(new Set(SEEDED_TRAINERS.map((t) => t.name)));
    expect(await clones.locator(".tr-nm").allTextContents()).toEqual(names);

    // `.tr-init` (the initials disc) is on EVERY card — it is the launch-common
    // state, because `marketing_photo_path` is null until the admin photo copy
    // (ENG-766) runs. Only the one seeded trainer with a photograph also carries
    // an `<img>`; the other eighteen render the disc alone. Asserting an exact
    // count of 19 photographs, as this test did before ENG-730, would now be
    // wrong by design.
    await expect(cards.locator(".tr-init"), "a card rendered no initials disc at all").toHaveCount(
      SEEDED_TRAINERS.length,
    );
    const initTexts = await cards.locator(".tr-init").allTextContents();
    expect(initTexts.every((text) => text.trim().length > 0), "a card rendered an empty initials disc").toBe(
      true,
    );

    // Exactly the one photographed seeded trainer renders an <img>; every other
    // card relies on the disc above, which is the launch-common state because
    // `marketing_photo_path` stays null until the admin photo copy (ENG-766).
    const photos = cards.locator("img");
    await expect(photos, "more than the single photographed trainer rendered an <img>").toHaveCount(1);
    await expect(photos).toHaveAttribute("src", new RegExp(`${SEEDED_TRAINER_WITH_PHOTO.photoPath}$`));

    // ...and it must actually LOAD. The seed uploads a real object into the
    // public `marketing-photos` bucket, so this exercises the whole path end to
    // end: `marketing_photo_path` -> unsigned public URL -> a decoded image.
    // Asserting only the `src` string would keep passing if the bucket went
    // private or the URL shape changed, which is most of what could break here.
    await expect
      .poll(
        async () => photos.first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
        { message: "the trainer photograph never decoded — check the bucket is public and the path unsigned" },
      )
      .toBe(true);
  });

  test("no trainer card falls back to retired placeholder copy", async ({ page }) => {
    test.skip(!seeded, "local Supabase has no public_trainer view — cannot seed the marketing roster");

    await page.goto("/");

    const text = (await page.locator("#stable-trainers").innerText()) ?? "";
    for (const placeholder of RETIRED_PLACEHOLDER_STRINGS) {
      expect(text, `retired placeholder copy ${JSON.stringify(placeholder)} rendered again`).not.toContain(
        placeholder,
      );
    }
  });

  test("the sparse seeded trainer omits its empty horses and bio lines but keeps its identity", async ({
    page,
  }) => {
    test.skip(!seeded, "local Supabase has no public_trainer view — cannot seed the marketing roster");

    await page.goto("/");

    const card = page
      .locator("#stable-trainers .tr-card:not([data-dup])")
      .filter({ hasText: SEEDED_TRAINER_SPARSE.name });

    await expect(card).toHaveCount(1);
    await expect(card.locator(".tr-nm")).toHaveText(SEEDED_TRAINER_SPARSE.name);
    await expect(card.locator(".tr-init")).not.toBeEmpty();
    await expect(card.locator(".tr-over .hz")).toHaveCount(0);
    await expect(card.locator(".tr-over .bio")).toHaveCount(0);
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

    test("no section is stuck invisible and all seeded trainers are visible", async ({ page }) => {
      test.skip(!seeded, "local Supabase has no public_trainer view — cannot seed the marketing roster");

      await page.goto("/");

      const hidden = await page.locator("main > header.hero, main > section").evaluateAll((els) =>
        els.filter((el) => getComputedStyle(el).opacity === "0").map((el) => el.className),
      );
      expect(hidden).toEqual([]);

      // Counted through the same `data-dup` contract as the scripted test. With
      // no scripting the marquee never runs, so the clone set is expected to be
      // absent entirely — which is the other half of why a hard total would be
      // the wrong assertion. The exact number is not the point of this test;
      // that every real card is actually visible, and that the real-card count
      // still matches the section's own count attribute, is.
      const realCards = page.locator(".tr-card:not([data-dup])");
      await expect(realCards).not.toHaveCount(0);
      await expect(page.locator(".tr-card[data-dup]")).toHaveCount(0);
      expect(await page.locator("#stable-trainers").getAttribute("data-trainer-count")).toBe(
        String(await realCards.count()),
      );

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
