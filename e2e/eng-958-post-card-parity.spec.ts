import { test, expect } from "@playwright/test";

/**
 * ENG-958 — post-card parity with mobile build 19 (R8/R9).
 *
 * Three parity items, one card: the label pill moves BELOW the byline, the head
 * avatar becomes a rounded box carrying the real photo, and the stable-update
 * panel clamps at eight measured lines with an in-place "Read more".
 *
 * WHY THE COMPONENT GALLERY AND NOT /explore. `.rx/gotchas.md` (ENG-613): the
 * local Supabase edge runtime serves a STUB `feed` function that returns
 * `{ data: [] }` regardless of content, so `/explore` and `/following` render
 * "Nothing here yet" and every assertion about a card there passes VACUOUSLY.
 * The no-auth gallery at `/preview/components` mounts the real shared `PostCard`
 * with fixture props, which is the surface this change actually lives on. The
 * profile feeds are the other honest option; they need a seeded run, and the
 * card is byte-identical on both.
 *
 * The screenshots land in `.rx/review/` (gitignored — evidence ships on a
 * `screenshots/eng-958` branch, never in this diff).
 */

const GALLERY = "/preview/components";

/**
 * EVERY locator is scoped to the round-8 section. The gallery deliberately keeps
 * every earlier round's fixtures on the same page, and several reuse the same
 * horse — an unscoped `filter({ hasText: "Winx" })` matches this ticket's card
 * AND the round-5 photo card it was spread from, which fails as a strict-mode
 * violation rather than as anything real.
 */
const section = (page: import("@playwright/test").Page) => page.getByTestId("round8-gallery");

/** The long update is the one that trips the 8-line clamp. */
const LONG_UPDATE = "Plenty to report from the stable this week";
const SHORT_UPDATE = "Short and sweet this week";

test.describe("ENG-958 post-card parity with mobile build 19", () => {
  test("the head stacks race badge, name, byline, THEN the pill", async ({ page }) => {
    await page.goto(GALLERY);
    const card = section(page).locator("article.post-web").filter({ hasText: "Winx" });
    await expect(card).toBeVisible();

    // Positional, not presence: the pill was PRESENT before this ticket too —
    // it was simply above the horse name. Only the geometry proves the restack.
    const box = async (sel: string) => {
      const b = await card.locator(sel).boundingBox();
      expect(b, `${sel} should be laid out`).not.toBeNull();
      return b!;
    };
    const badge = await box(".race-badge");
    const horse = await box(".post-horse");
    const byline = await box(".post-byline");
    const pill = await box(".post-badge");

    expect(badge.y).toBeLessThan(horse.y);
    expect(horse.y).toBeLessThan(byline.y);
    // THE PARITY ITEM: the pill is now the LAST of the four, under the byline.
    expect(pill.y).toBeGreaterThan(byline.y);

    // It gets the whole column rather than sharing the name's line — which is
    // the truncation fix the restack exists for.
    await expect(card.locator(".post-badge")).toHaveClass(/stacked/);
  });

  test("a long label ELLIPSISES inside the pill rather than clipping mid-word", async ({ page }) => {
    await page.goto(GALLERY);
    // Located by the LABEL, not the horse name: the long stable-update fixture's
    // body also mentions Sunshine In Paris, so a name filter matches two cards.
    const card = section(page)
      .locator("article.post-web")
      .filter({ has: page.locator(".post-badge-text", { hasText: "Race Replay" }) });
    const text = card.locator(".post-badge-text");
    await expect(text).toBeVisible();

    // THE REASON THIS TEST EXISTS. `.post-badge` is `inline-flex`, and
    // `text-overflow` only applies to a BLOCK container that directly holds the
    // overflowing inline content — put it on the flex container and the copy
    // becomes an anonymous flex item, the ellipsis is never drawn, and the title
    // is hard-clipped mid-word while looking deliberate. Every other labelled
    // fixture is short enough to fit, so without a long one this regresses green.
    const metrics = await text.evaluate((el) => ({
      display: getComputedStyle(el).display,
      textOverflow: getComputedStyle(el).textOverflow,
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
    }));
    // It must actually be overflowing, or the assertion below proves nothing.
    expect(metrics.scrollW).toBeGreaterThan(metrics.clientW);
    expect(metrics.textOverflow).toBe("ellipsis");
    // The ellipsis needs a non-flex box to apply to.
    expect(metrics.display).not.toContain("flex");

    // And the pill must not have burst the column to fit the title.
    const pill = (await card.locator(".post-badge").boundingBox())!;
    const meta = (await card.locator(".post-meta-web").boundingBox())!;
    expect(pill.width).toBeLessThanOrEqual(meta.width + 1);
  });

  test("head avatars are rounded BOXES and the panel footer disc stays a CIRCLE", async ({ page }) => {
    await page.goto(GALLERY);

    // Computed style, so this is the real cascade rather than the stylesheet
    // text — the same standard the ENG-613 spec holds the name treatment to.
    const headRadius = await section(page)
      .locator("article.post-web .post-avatar-web")
      .first()
      .evaluate((el) => getComputedStyle(el).borderRadius);
    expect(headRadius).toBe("14px");
    expect(headRadius).not.toContain("50%");

    // THE CONTROL. The stable-update footer is a stable's MARK, not a profile
    // photo, and mobile keeps it circular. If a later "round the avatars" sweep
    // ever takes this with it, this line is what says so.
    const footAv = section(page).locator("article.post-web .post-panel-foot .av").first();
    const footRadius = await footAv.evaluate((el) => {
      const s = getComputedStyle(el);
      return { radius: s.borderRadius, width: s.width, height: s.height };
    });
    // `getComputedStyle` returns a percentage radius VERBATIM ("50%") rather
    // than resolving it against the box, so this compares the token, not px.
    // The head above resolves to "14px" — the two are distinguishable exactly
    // because one is a percentage and the other is not, which is the whole
    // circle-vs-box distinction this ticket turns on.
    expect(footRadius.radius).toBe("50%");
    expect(footRadius.width).toBe(footRadius.height);
  });

  test("the head paints the real photo, and falls back to the monogram without one", async ({ page }) => {
    await page.goto(GALLERY);

    const withPhoto = section(page).locator("article.post-web").filter({ hasText: "Winx" });
    const img = withPhoto.getByTestId("post-avatar-photo");
    await expect(img).toBeVisible();

    // A SCREENSHOT PROVES NOTHING UNLESS THE IMAGE DECODED (.rx/gotchas.md,
    // ENG-762): a broken source still has its `src` and still passes a
    // visibility check, while the committed picture shows a broken-image icon.
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
      .toBe(true);

    // The fixture beside it has no photo and must still draw its letter.
    const noPhoto = section(page).locator("article.post-web").filter({ hasText: "Trackwork" }).first();
    await expect(noPhoto.getByTestId("post-avatar-photo")).toHaveCount(0);
    await expect(noPhoto.locator(".post-avatar-web")).toHaveText("M");
  });

  test("a long stable update clamps, expands in place, and collapses again", async ({ page }) => {
    await page.goto(GALLERY);
    const card = section(page).locator("article.post-web").filter({ hasText: LONG_UPDATE });
    await expect(card).toBeVisible();

    const clamp = card.getByTestId("post-panel-clamp");
    const readMore = card.getByTestId("post-panel-read-more");

    // Clamped: the box shows LESS than the prose it contains.
    const clampedHeight = (await clamp.boundingBox())!.height;
    const proseHeight = (await card.getByTestId("post-panel-prose").boundingBox())!.height;
    expect(clampedHeight).toBeLessThan(proseHeight);

    // NO TRAILING DOTS — the explicit parity item (Justin, 26 Aug 2026). An
    // exact match, because a `toContainText` would pass on "Read more…" too.
    await expect(readMore).toHaveText("Read more");
    await expect(readMore).toHaveAttribute("aria-expanded", "false");

    // THE AFFORDANCE MUST NOT LIVE INSIDE THE CLAMPED BOX — a clipped container
    // would hide the very control that unclamps it (.rx/gotchas.md, ENG-761).
    await expect(clamp.getByTestId("post-panel-read-more")).toHaveCount(0);

    await readMore.click();
    await expect(readMore).toHaveText("Read less");
    await expect(readMore).toHaveAttribute("aria-expanded", "true");
    const expandedHeight = (await clamp.boundingBox())!.height;
    expect(expandedHeight).toBeGreaterThan(clampedHeight);

    // It collapses again — only the PANEL offers the way back (the caption does
    // not, and there is no post-detail route on web to send anyone to).
    await readMore.click();
    await expect(readMore).toHaveText("Read more");
    expect((await clamp.boundingBox())!.height).toBeCloseTo(clampedHeight, 0);
  });

  test("a short update is not clamped and offers no affordance at all", async ({ page }) => {
    await page.goto(GALLERY);
    const card = section(page).locator("article.post-web").filter({ hasText: SHORT_UPDATE });
    await expect(card).toBeVisible();
    // The failure this guards is an affordance under copy that is already
    // complete — tapping it would reveal nothing.
    await expect(card.getByTestId("post-panel-read-more")).toHaveCount(0);
  });

  test("captures the parity evidence", async ({ page }) => {
    await page.goto(GALLERY);
    const gallery = page.getByTestId("round8-gallery");
    await expect(gallery).toBeVisible();

    // Every avatar photo must have DECODED before anything is captured.
    const photos = gallery.getByTestId("post-avatar-photo");
    for (let i = 0; i < (await photos.count()); i += 1) {
      await expect
        .poll(() =>
          photos.nth(i).evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
        )
        .toBe(true);
    }

    // PLAYWRIGHT ELEMENT SCREENSHOTS STITCH (.rx/gotchas.md, ENG-762):
    // compositing several scroll positions captures every absolutely-positioned
    // child MORE THAN ONCE, which reads as a duplicated-chip bug in the
    // evidence. A viewport taller than the element is the fix.
    const height = Math.ceil((await gallery.boundingBox())!.height) + 200;
    await page.setViewportSize({ width: 900, height });
    await expect(gallery).toBeVisible();

    await gallery.screenshot({ path: ".rx/review/eng-958-gallery-clamped.png" });

    // The same stack, expanded, so the reviewer can see both clamp states.
    const card = section(page).locator("article.post-web").filter({ hasText: LONG_UPDATE });
    await card.getByTestId("post-panel-read-more").click();
    await expect(card.getByTestId("post-panel-read-more")).toHaveText("Read less");
    await card.screenshot({ path: ".rx/review/eng-958-update-expanded.png" });

    // The restacked head on its own — the side-by-side against mobile build 19
    // is read at this crop.
    await section(page)
      .locator("article.post-web")
      .filter({ hasText: "Winx" })
      .screenshot({ path: ".rx/review/eng-958-head-restack.png" });
  });
});
