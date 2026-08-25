import { test, expect } from "@playwright/test";

// ENG-815 — visual evidence that the carousel still LOOKS exactly as ENG-762
// shipped it while its slides now arrive through the mint helper.
//
// WHY THE GALLERY AND NOT LIVE DATA. `eng-762-photo-carousel.spec.ts` drives the
// real read path against local Postgres and Storage, and it remains the evidence
// for that path. It cannot run here: after ENG-815 the slides come from the be
// `post-media` edge function's `{ postId, slideIndex }` mode, which landed on the
// be's `feature/round6-v1` and is NOT on be `main`, and the local edge runtime is
// a shared stack this worker must not repoint. See the PR's test-evidence
// section, where that gap is disclosed.
//
// So this captures the LAYER THIS TICKET CHANGED — the indicator, the geometry
// and the paging — on `/preview/components`, whose fixtures answer the mint call
// locally in the be's exact response shape. It proves the two visual acceptance
// criteria that do not need a database:
//
//   * the dots reflect the true count, drawn from `slideCount` before slides
//     past the first have been minted;
//   * a single-photo post is visually unchanged.
//
// It is deliberately NOT evidence for the read path (the gallery builds PostCard
// props by hand and bypasses both the projection and the mapper — .rx/gotchas.md).
const SHOTS = ".rx/review";

test("ENG-815 the carousel pages through minted slides with the count-driven dots", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 2400 });
  await page.goto("/preview/components#round6-carousel");

  const gallery = page.getByTestId("round6-carousel-gallery");
  await expect(gallery).toBeVisible({ timeout: 120_000 });

  const card = gallery.locator(".post-web").first();
  const dots = card.getByTestId("photo-dots").getByRole("button");
  const count = card.getByTestId("media-photo-count");
  const track = card.getByTestId("photo-track");
  const imgs = card.getByTestId("photo-slide").locator("img");

  // --- FIRST: three dots from `slideCount`, two photos in hand -------------
  await expect(dots).toHaveCount(3);
  await expect(count).toHaveText("1/3");
  // Slide 0 came in the batch, slide 1 was prefetched on mount, slide 2 has not
  // been asked for. Three dots over two images IS the feature.
  await expect.poll(async () => imgs.count(), { timeout: 15_000 }).toBe(2);
  await card.screenshot({ path: `${SHOTS}/eng-815-01-carousel-first.png` });

  // --- LAST: arriving is what mints it ------------------------------------
  await dots.nth(2).click();
  await expect(count).toHaveText("3/3");
  await expect.poll(async () => imgs.count(), { timeout: 15_000 }).toBe(3);
  await expect
    .poll(async () => track.evaluate((el) => Math.abs(el.scrollLeft - el.clientWidth * 2) <= 1))
    .toBe(true);
  await card.screenshot({ path: `${SHOTS}/eng-815-02-carousel-last-minted.png` });

  // The box must not have changed height between slides — one aspect box per
  // post is why the box is not per-photo, and a lazily-arriving slide must not
  // change that.
  const box = card.locator(".post-media-web");
  const atLast = await box.boundingBox();
  await dots.nth(0).click();
  await expect.poll(async () => track.evaluate((el) => el.scrollLeft <= 1)).toBe(true);
  const atFirst = await box.boundingBox();
  expect(Math.round(atLast!.height)).toBe(Math.round(atFirst!.height));

  // --- A SINGLE-PHOTO POST IS UNCHANGED -----------------------------------
  const single = gallery.locator(".post-web").nth(1);
  await expect(single.getByTestId("media-photo-chip")).toHaveAttribute("aria-label", "Photo");
  await expect(single.getByTestId("photo-dots")).toHaveCount(0);
  await expect(single.getByTestId("photo-track")).toHaveCount(0);
  await expect(single.getByTestId("media-photo-count")).toHaveCount(0);
  await single.screenshot({ path: `${SHOTS}/eng-815-03-single-photo-unchanged.png` });

  await gallery.screenshot({ path: `${SHOTS}/eng-815-04-gallery-all-states.png` });
});
