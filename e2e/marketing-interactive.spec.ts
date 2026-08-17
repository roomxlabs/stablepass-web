import { test, expect, devices, type Page } from "@playwright/test";

/**
 * The interactive layer (ENG-589 / W3) — behavioural evidence.
 *
 * Public and static like the W1/W2 specs, so no session and no Supabase.
 * Screenshots and the marquee's motion frames land in .rx/review/ and are
 * committed, per .rx/fe-harness.md.
 */

const SHOT_DIR = ".rx/review";
/** Gitignored: raw marquee frames, assembled into one committed GIF. */
const FRAME_DIR = "test-results/eng-589-marquee-frames";
const DESKTOP = { width: 1440, height: 900 };

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

/** The track's current translateX, read off the computed matrix. */
async function offsetOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const track = document.querySelector<HTMLElement>(".tr-track");
    if (!track) return Number.NaN;
    const { transform } = getComputedStyle(track);
    if (!transform || transform === "none") return 0;
    return new DOMMatrixReadOnly(transform).m41;
  });
}

/**
 * Names of the trainers whose card is currently inside the strip's window.
 *
 * This is the "same face twice" criterion made observable: a name appearing
 * twice in this list means an original and its clone are on screen together.
 */
async function visibleTrainerNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scroll = document.querySelector(".tr-scroll");
    if (!scroll) return [];
    const window_ = scroll.getBoundingClientRect();

    return [...document.querySelectorAll<HTMLElement>(".tr-card")]
      .filter((card) => {
        const box = card.getBoundingClientRect();
        // A one-pixel tolerance: a card flush against the edge is not "visible".
        return box.right > window_.left + 1 && box.left < window_.right - 1;
      })
      .map((card) => card.querySelector(".tr-nm")?.textContent ?? "");
  });
}

function duplicatesIn(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
}

/**
 * Park the drift by putting a real cursor over the track.
 *
 * `locator.hover()` cannot be used here: its actionability check waits for the
 * element to be "stable" — an unchanged bounding box across two animation
 * frames — and a marquee that is drifting by design never becomes stable, so
 * the call times out. (That timeout is itself evidence the rAF loop is running,
 * but it is not a usable way to drive the page.) `mouse.move` dispatches the
 * same real mouseenter with no actionability check.
 */
async function pauseDrift(page: Page) {
  const strip = page.locator(".tr-scroll");
  // Mouse coordinates are VIEWPORT-relative, and the trainer strip sits about
  // 6,700px down a long page. Without scrolling to it first the move lands
  // below the viewport, no mouseenter fires, and the drift never pauses.
  await strip.scrollIntoViewIfNeeded();
  const box = await strip.boundingBox();
  if (!box) throw new Error(".tr-scroll has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Long enough for the pause to take and for the hovered card's own
  // scale transition (.32s) to settle, so clicks find a stable target.
  await page.waitForTimeout(400);
}

/** Move the cursor clear of the strip so the drift resumes. */
async function resumeDrift(page: Page) {
  // Top-left of the viewport is always clear of the strip, whatever the scroll.
  await page.mouse.move(5, 5);
  await page.waitForTimeout(150);
}

test.describe("trainer marquee — hover-capable desktop", () => {
  test.use({ viewport: DESKTOP });

  test("drifts, pauses on hover, and resumes on leave", async ({ page }) => {
    await page.goto("/");
    await page.locator("#stable-trainers .tr-card").first().waitFor();
    await imagesSettled(page);

    // It decided to loop, which is the precondition for any of this.
    await expect(page.locator('.tr-card[data-dup="1"]').first()).toBeAttached();
    await expect(page.locator(".tr-scroll")).not.toHaveClass(/is-static/);

    const start = await offsetOf(page);
    await page.waitForTimeout(600);
    const drifted = await offsetOf(page);
    expect(drifted, "the strip never moved").not.toBeCloseTo(start, 1);

    // Hovering the track pauses it.
    await pauseDrift(page);
    await page.waitForTimeout(150);
    const paused = await offsetOf(page);
    await page.waitForTimeout(600);
    expect(await offsetOf(page), "hover did not pause the drift").toBeCloseTo(paused, 1);

    // Moving away resumes it.
    await resumeDrift(page);
    await page.waitForTimeout(600);
    expect(await offsetOf(page), "leaving did not resume the drift").not.toBeCloseTo(paused, 1);
  });

  test("the arrows nudge the same offset the drift uses", async ({ page }) => {
    await page.goto("/");
    await page.locator("#stable-trainers .tr-card").first().waitFor();

    await pauseDrift(page);
    const before = await offsetOf(page);

    await page.locator('#stable-trainers [data-tr="1"]').click();
    await page.waitForTimeout(600);
    const forward = await offsetOf(page);

    /**
     * One card plus its gap is 244px at this width; the drift covers about 9px
     * in the same window, so a jump this size can only be the arrow.
     *
     * The offsets are deliberately NOT expected to round-trip exactly. Clicking
     * an arrow moves the cursor off the track, so `mouseleave` fires and the
     * drift correctly resumes — which is the design: the arrow and the drift
     * move the SAME offset, so they compose instead of fighting. A CSS keyframe
     * could not be nudged like this, and that is why decision 1 chose rAF.
     */
    expect(Math.abs(forward - before)).toBeGreaterThan(150);

    // Nudging back past the start must WRAP, never translate positive — a
    // positive translate drags the empty space behind the strip into view.
    for (let i = 0; i < 3; i += 1) {
      await page.locator('#stable-trainers [data-tr="-1"]').click();
      await page.waitForTimeout(550);
    }
    expect(await offsetOf(page), "the track translated the wrong way").toBeLessThanOrEqual(0.5);
  });

  /** The guard, checked at the three widths the ticket names. */
  for (const width of [1440, 1024, 768]) {
    test(`never shows the same trainer twice at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await page.locator("#stable-trainers .tr-card").first().waitFor();
      await imagesSettled(page);

      // Sample across a stretch of the drift rather than trusting one frame.
      for (let i = 0; i < 8; i += 1) {
        const names = await visibleTrainerNames(page);
        expect(names.length, "no cards were visible at all").toBeGreaterThan(0);
        expect(duplicatesIn(names), `the same trainer was on screen twice at ${width}px`).toEqual([]);
        await page.waitForTimeout(250);
      }
    });
  }
});

test.describe("trainer marquee — reduced motion", () => {
  test.use({ viewport: DESKTOP });

  test("does not drift, but the arrows still work", async ({ page }) => {
    // Set before the first navigation so the mount effect reads it. (`test.use`
    // has no `reducedMotion` option on this Playwright version.)
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.locator("#stable-trainers .tr-card").first().waitFor();

    const start = await offsetOf(page);
    await page.waitForTimeout(900);
    expect(await offsetOf(page), "it drifted despite prefers-reduced-motion").toBeCloseTo(start, 1);

    await page.locator('#stable-trainers [data-tr="1"]').click();
    await page.waitForTimeout(700);
    expect(await offsetOf(page), "the arrows stopped working too").not.toBeCloseTo(start, 1);
  });
});

test.describe("trainer marquee — touch", () => {
  /**
   * Only the emulation fields, NOT a full `...devices["iPhone 13"]` spread:
   * that carries `defaultBrowserType`, which forces a new worker and is
   * rejected inside a describe group. `isMobile` + `hasTouch` are what make
   * Chromium report `(hover: none)`, which is all this suite needs.
   */
  const iphone = devices["iPhone 13"];
  test.use({
    viewport: iphone.viewport,
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: iphone.isMobile,
    hasTouch: iphone.hasTouch,
  });

  test("scrolls natively with no drift and no duplicate set", async ({ page }) => {
    await page.goto("/");
    await page.locator("#stable-trainers .tr-card").first().waitFor();

    expect(await page.evaluate(() => matchMedia("(hover: none)").matches)).toBe(true);

    // No clones, and the track is never transformed — the observable form of
    // "no rAF at all". The unit suite asserts requestAnimationFrame itself.
    await expect(page.locator("[data-dup]")).toHaveCount(0);
    const start = await offsetOf(page);
    await page.waitForTimeout(900);
    expect(await offsetOf(page)).toBeCloseTo(start, 1);

    // `.is-static` would wrap the track into a block, leaving nothing to swipe.
    await expect(page.locator(".tr-scroll")).not.toHaveClass(/is-static/);

    const scrolledBefore = await page.evaluate(() => document.querySelector(".tr-scroll")!.scrollLeft);
    await page.locator('#stable-trainers [data-tr="1"]').click();
    await page.waitForTimeout(700);
    const scrolledAfter = await page.evaluate(() => document.querySelector(".tr-scroll")!.scrollLeft);
    expect(scrolledAfter, "the arrow did not scroll the strip").toBeGreaterThan(scrolledBefore);
  });
});

test.describe("dialogs", () => {
  test.use({ viewport: DESKTOP });

  test("a trainer card opens the modal, and every close path returns focus", async ({ page }) => {
    await page.goto("/");
    const card = page.locator("#stable-trainers .tr-card:not([data-dup])").first();
    await card.waitFor();
    await imagesSettled(page);

    // Pause the drift so the card stays under the cursor.
    await pauseDrift(page);
    await card.click();

    const modal = page.locator("#tr-modal");
    await expect(modal).toHaveAttribute("open", "");
    await expect(modal.locator("#trm-name")).not.toBeEmpty();
    await expect(modal.locator("#trm-loc")).not.toBeEmpty();
    await expect(modal.locator("#trm-img")).toHaveAttribute("src", /\/marketing\//);
    // Focus lands on the close button, so Esc and Tab are both immediately usable.
    await expect(modal.locator("[data-close]")).toBeFocused();

    await page.screenshot({ path: `${SHOT_DIR}/eng-589-trainer-modal.png` });

    await page.keyboard.press("Escape");
    await expect(modal).not.toHaveAttribute("open", "");
  });

  test("the FAQ sheet opens from the section's View all and closes on Escape", async ({ page }) => {
    await page.goto("/");
    await page.locator('#faq [data-sheet="faq"]').click();

    const sheet = page.locator("#sheet-faq");
    await expect(sheet).toHaveAttribute("open", "");
    await expect(sheet.locator("details")).toHaveCount(13);
    await expect(sheet).toHaveAttribute("aria-modal", "true");

    await page.screenshot({ path: `${SHOT_DIR}/eng-589-faq-sheet.png` });

    await page.keyboard.press("Escape");
    await expect(sheet).not.toHaveAttribute("open", "");
  });

  test("only one dialog is open at a time", async ({ page }) => {
    await page.goto("/");
    await page.locator('#faq [data-sheet="faq"]').click();
    await expect(page.locator("#sheet-faq")).toHaveAttribute("open", "");

    // Close it, then open the other: the scrim makes a direct swap unreachable
    // by a real visitor, so this checks the invariant the shell enforces.
    await page.keyboard.press("Escape");
    await pauseDrift(page);
    await page.locator("#stable-trainers .tr-card:not([data-dup])").first().click();

    await expect(page.locator("[open]")).toHaveCount(1);
    await expect(page.locator("#tr-modal")).toHaveAttribute("open", "");
  });
});

test.describe("the footer's links", () => {
  test.use({ viewport: DESKTOP });

  test("Legal navigates to W4's real routes", async ({ page }) => {
    await page.goto("/");

    const legal = page.locator(".foot-col").nth(2);
    await expect(legal.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/legal/privacy");
    await expect(legal.getByRole("link", { name: "Terms & Conditions" })).toHaveAttribute("href", "/legal/terms");
    await expect(legal.getByRole("link", { name: "Cancellation & Refund Policy" })).toHaveAttribute(
      "href",
      "/legal/cancellation",
    );
    await expect(legal.getByRole("link", { name: "Acceptable Use Policy" })).toHaveAttribute(
      "href",
      "/legal/acceptable-use",
    );

    // ...and one of them actually lands, rather than merely being well-formed.
    await legal.getByRole("link", { name: "Privacy Policy" }).click();
    await expect(page).toHaveURL(/\/legal\/privacy$/);
    await expect(page.locator("h1")).toBeVisible();
  });

  test("Support contacts are mailto links carrying their subject, and nothing sends", async ({ page }) => {
    await page.goto("/");

    const support = page.locator(".foot-col").nth(1);
    await expect(support.getByRole("link", { name: "Contact us" })).toHaveAttribute(
      "href",
      /^mailto:[^?]+\?subject=General%20enquiry$/,
    );
    await expect(support.getByRole("link", { name: "Subscriber support" })).toHaveAttribute(
      "href",
      /subject=Subscriber%20support$/,
    );
    await expect(support.getByRole("link", { name: "Trainer partnerships" })).toHaveAttribute(
      "href",
      /subject=Trainer%20partnerships$/,
    );

    // The fake send is gone: no form, no confirmation, nowhere on the page.
    await expect(page.locator("#sheet-contact")).toHaveCount(0);
    await expect(page.locator("form")).toHaveCount(0);
    expect(await page.content()).not.toContain("on its way");
  });

  test("the trainer CTAs still reach the mail client through the delegate", async ({ page }) => {
    await page.goto("/");

    // for-trainers.tsx is out of this ticket's surface, so its buttons stayed
    // buttons and are served by the document delegate instead.
    const cta = page.locator('#trainers [data-sheet="contact"]').first();
    await expect(cta).toHaveAttribute("data-subject", "Trainer partnerships");

    const navigations: string[] = [];
    page.on("request", (request) => navigations.push(request.url()));
    await cta.click();
    await page.waitForTimeout(300);

    // A mailto hands off to the OS; what matters is that nothing was POSTed.
    expect(navigations.filter((url) => /\/api\//.test(url))).toEqual([]);
  });
});

test.describe("with scripting off (the client's review condition)", () => {
  test.use({ viewport: DESKTOP, javaScriptEnabled: false });

  test("shows all nineteen trainers, navigable legal links, and nothing stuck invisible", async ({ page }) => {
    await page.goto("/");
    await imagesSettled(page);

    // Every card rendered AND actually visible — `.is-static` is what stops
    // overflow:hidden clipping thirteen of them.
    const cards = page.locator("#stable-trainers .tr-card");
    await expect(cards).toHaveCount(19);
    await expect(page.locator(".tr-scroll")).toHaveClass(/is-static/);

    const hidden = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".marketing .rv")].filter(
        (el) => Number(getComputedStyle(el).opacity) < 0.99,
      ).length,
    );
    expect(hidden, "a section was left at opacity:0 with no script to reveal it").toBe(0);

    const clipped = await page.evaluate(() => {
      const scroll = document.querySelector(".tr-scroll")!.getBoundingClientRect();
      return [...document.querySelectorAll(".tr-card")].filter((card) => {
        const box = card.getBoundingClientRect();
        return box.right <= scroll.left || box.left >= scroll.right;
      }).length;
    });
    expect(clipped, "cards were clipped outside the strip with scripting off").toBe(0);

    await expect(page.locator(".foot-col").nth(2).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/legal/privacy",
    );
    await expect(page.locator(".foot-col").nth(1).getByRole("link", { name: "Contact us" })).toHaveAttribute(
      "href",
      /^mailto:/,
    );

    await page.locator("#stable-trainers").screenshot({ path: `${SHOT_DIR}/eng-589-nojs-trainers.png` });
  });
});

/**
 * Motion evidence. A still cannot show drift, so this captures a frame sequence
 * of the strip, which is then assembled into `.rx/review/eng-589-marquee.gif`
 * for the PR.
 *
 * The frames land in the already-gitignored `test-results/` because only the
 * assembled GIF is worth committing — two dozen near-identical PNGs are not.
 * Kept last so it never delays the assertions above.
 */
test.describe("motion evidence", () => {
  test.use({ viewport: DESKTOP });

  test("captures the marquee drifting", async ({ page }) => {
    await page.goto("/");
    await page.locator("#stable-trainers .tr-card").first().waitFor();
    await imagesSettled(page);
    await expect(page.locator('.tr-card[data-dup="1"]').first()).toBeAttached();

    const strip = page.locator(".tr-scroll");

    /**
     * Wait for W1's reveal to finish before the first frame.
     *
     * `.rv` starts at `opacity:0` and only animates in once the observer adds
     * `.in`, which needs the strip scrolled into view. Capturing before that
     * lands a blank first frame in the GIF — the drift is real either way, but
     * the evidence opens on an empty band.
     */
    await strip.scrollIntoViewIfNeeded();
    await expect(strip).toHaveClass(/\bin\b/);
    await page.waitForTimeout(900); // the .75s reveal transition, plus margin

    const offsets: number[] = [];

    for (let frame = 0; frame < 24; frame += 1) {
      offsets.push(await offsetOf(page));
      await strip.screenshot({ path: `${FRAME_DIR}/frame-${String(frame).padStart(2, "0")}.png` });
      await page.waitForTimeout(90);
    }

    // The frames are only evidence if the strip actually moved between them.
    expect(Math.abs(offsets[offsets.length - 1] - offsets[0])).toBeGreaterThan(5);
  });
});
