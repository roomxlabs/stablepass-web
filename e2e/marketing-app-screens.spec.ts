import { test, expect, type Page } from "@playwright/test";

/**
 * The eight app screens in `#mem-apps` — behavioural evidence that the row
 * actually moves.
 *
 * W2 shipped the `[data-ma]` arrows inert on the contract that W3 would bind
 * them; W3 wired only the trainer strip. The row therefore reached production
 * with NO driver at all: no drift, dead arrows, and `.ma-scroll{overflow:hidden}`
 * over a `width:max-content` row, so the last three screens were unreachable.
 *
 * Deliberately a real browser and not jsdom: the drift is a `requestAnimationFrame`
 * loop, and the component test can only prove the arrows are wired to the hook.
 * Whether the row MOVES is only observable where rAF actually runs.
 *
 * Public and static, so no session and no Supabase. Writes no screenshots —
 * `.rx/review/` holds committed PNGs and this spec has no business touching them.
 */

const DESKTOP = { width: 1440, height: 900 };

/** The app row's current translateX, read off the computed matrix. */
async function offsetOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const track = document.querySelector<HTMLElement>("#mem-apps .ma-row");
    if (!track) return Number.NaN;
    const { transform } = getComputedStyle(track);
    if (!transform || transform === "none") return 0;
    return new DOMMatrixReadOnly(transform).m41;
  });
}

/**
 * Park the drift with a real cursor over the row.
 *
 * `locator.hover()` is unusable here for the same reason as the trainer strip:
 * its actionability check waits for a stable bounding box across two frames, and
 * a row that drifts by design never becomes stable, so the call times out.
 * `mouse.move` dispatches the same real mouseenter with no such check.
 */
async function pauseDrift(page: Page) {
  const strip = page.locator("#mem-apps .ma-scroll");
  // Mouse coordinates are viewport-relative and this row sits a long way down
  // the page; without scrolling first the move lands outside the viewport and
  // no mouseenter ever fires.
  await strip.scrollIntoViewIfNeeded();
  const box = await strip.boundingBox();
  if (!box) throw new Error("#mem-apps .ma-scroll has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Long enough for the pause to take and for the hovered phone's own
  // transform transition (.32s) to settle.
  await page.waitForTimeout(400);
}

async function resumeDrift(page: Page) {
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
}

test.describe("app screens row — hover-capable desktop", () => {
  test.use({ viewport: DESKTOP });

  test("drifts, pauses on hover, and resumes on leave", async ({ page }) => {
    await page.goto("/");
    await page.locator("#mem-apps .ma-scroll").scrollIntoViewIfNeeded();
    // The clone decision is measured on mount; give it a frame to publish.
    await page.waitForTimeout(300);

    // The duplicate set is the precondition for drifting at all — translating a
    // single set would drag its tail into open space.
    await expect(page.locator("#mem-apps .ma[data-dup]")).toHaveCount(8);

    const start = await offsetOf(page);
    await page.waitForTimeout(700);
    const drifted = await offsetOf(page);
    expect(drifted, "the row never moved — this is the shipped bug").not.toBeCloseTo(start, 1);

    await pauseDrift(page);
    const paused = await offsetOf(page);
    await page.waitForTimeout(500);
    expect(await offsetOf(page), "hover did not pause the drift").toBeCloseTo(paused, 1);

    await resumeDrift(page);
    await page.waitForTimeout(400);
    expect(await offsetOf(page), "leaving did not resume the drift").not.toBeCloseTo(paused, 1);
  });

  test("the arrows nudge the same offset the drift uses", async ({ page }) => {
    await page.goto("/");
    // Paused first, so the drift cannot move the offset underneath the
    // measurement and turn this into a flaky comparison.
    await pauseDrift(page);

    const before = await offsetOf(page);
    await page.locator('#mem-apps [data-ma="1"]').click();
    // Past the .45s nudge easing.
    await page.waitForTimeout(600);
    const forward = await offsetOf(page);

    /**
     * One phone plus its gap is 212 + 44 = 256px at this width; the drift covers
     * only tens of pixels in the same window, so a jump this size can only be
     * the arrow.
     *
     * NOT expected to round-trip exactly. Clicking an arrow moves the cursor off
     * the row, so `mouseleave` fires and the drift correctly resumes — the arrow
     * and the drift move the SAME offset, so they compose rather than fight. A
     * CSS keyframe could not be nudged like this, which is why decision 1 chose
     * rAF.
     */
    expect(Math.abs(forward - before)).toBeGreaterThan(150);

    // Nudging back past the start must WRAP, never translate positive: a
    // positive translate drags the empty space behind the row into view.
    for (let i = 0; i < 3; i += 1) {
      await page.locator('#mem-apps [data-ma="-1"]').click();
      await page.waitForTimeout(550);
    }
    expect(await offsetOf(page), "the row translated the wrong way").toBeLessThanOrEqual(0.5);
  });
});

test.describe("app screens row — reduced motion", () => {
  test.use({ viewport: DESKTOP });

  /**
   * The source returns the arrows even with the drift off: an arrow is a
   * deliberate action, not motion the visitor did not ask for.
   */
  test("does not drift, but the arrows still work", async ({ page }) => {
    // Set before the first navigation so the mount effect reads it. (`test.use`
    // has no `reducedMotion` option on this Playwright version — passing it
    // there is silently ignored and the page runs in drift mode.)
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator("#mem-apps .ma-scroll").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);

    const start = await offsetOf(page);
    await page.waitForTimeout(900);
    expect(await offsetOf(page), "it drifted despite prefers-reduced-motion").toBeCloseTo(start, 1);

    await page.locator('#mem-apps [data-ma="1"]').click();
    await page.waitForTimeout(700);
    expect(await offsetOf(page), "the arrows stopped working too").not.toBeCloseTo(start, 1);
  });
});
