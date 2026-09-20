import { test, expect } from "@playwright/test";

/**
 * ENG-1270 — the three post SUBJECT variants (horse / trainer / stablepass),
 * side by side.
 *
 * WHY THE COMPONENT GALLERY AND NOT /explore. `.rx/gotchas.md` (ENG-613): the
 * local Supabase edge runtime serves a STUB `feed` function that returns
 * `{ data: [] }` regardless of content, so `/explore` and `/following` render
 * their empty state and every assertion about a card there would pass
 * VACUOUSLY. The no-auth gallery at `/preview/components` mounts the real
 * shared `PostCard`/`PostHead` with fixture props, which is the surface this
 * change actually lives on.
 *
 * Screenshots land in `.rx/review/` (gitignored — evidence ships separately,
 * never in this diff).
 */

const GALLERY = "/preview/components";

/** Every locator is scoped to the subject gallery, so a sibling round's fixture
 * (which may share a class or a photo) can never be matched by accident. */
const section = (page: import("@playwright/test").Page) => page.getByTestId("subject-gallery");

test.describe("ENG-1270 post subject variants", () => {
  test("renders the three cards in order: horse, trainer, stablepass", async ({ page }) => {
    await page.goto(GALLERY);
    const cards = section(page).locator("article.post-web");
    await expect(cards).toHaveCount(3);

    // Order is the point: the gallery names it explicitly (`SUBJECT_HORSE_POST`,
    // `SUBJECT_TRAINER_POST`, `SUBJECT_STABLEPASS_POST`), and the head's
    // `data-subject` attribute (post-head.tsx) lets us read it back without
    // depending on any particular copy.
    const subjects = await cards.locator("h3[data-subject]").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-subject")),
    );
    expect(subjects).toEqual(["horse", "trainer", "stablepass"]);
  });

  test("the trainer card's head is a link to /trainers/trainer-1", async ({ page }) => {
    await page.goto(GALLERY);
    const card = section(page).locator("article.post-web").nth(1);

    const link = card.locator('[data-testid="post-head-link"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "/trainers/trainer-1");
    await expect(card.locator("h3")).toHaveText("Chris Waller");
  });

  test("the StablePass card's head has no link, its h3 is exactly 'stablepass', and its mark is /brand/mark.png", async ({ page }) => {
    await page.goto(GALLERY);
    const card = section(page).locator("article.post-web").nth(2);

    await expect(card.locator('[data-testid="post-head-link"]')).toHaveCount(0);

    const heading = card.locator("h3");
    await expect(heading).toHaveText("stablepass");

    const mark = card.getByTestId("post-head-mark");
    await expect(mark).toBeVisible();
    const src = await mark.getAttribute("src");
    expect(src).not.toBeNull();
    expect(src!.endsWith("/brand/mark.png")).toBe(true);
  });

  test("all three cards carry the same reaction bar and label pill below the head — only the head varies", async ({ page }) => {
    await page.goto(GALLERY);
    const cards = section(page).locator("article.post-web");
    await expect(cards).toHaveCount(3);

    for (let i = 0; i < 3; i += 1) {
      const card = cards.nth(i);
      await expect(card.locator(".post-actions-web")).toBeVisible();
      await expect(card.locator(".post-badge-text")).toBeVisible();
    }
  });

  test("captures the subject-variant evidence", async ({ page }) => {
    await page.goto(GALLERY);
    const gallery = section(page);
    await expect(gallery).toBeVisible();

    const cards = gallery.locator("article.post-web");
    await expect(cards).toHaveCount(3);

    // PLAYWRIGHT ELEMENT SCREENSHOTS STITCH (.rx/gotchas.md, ENG-762):
    // compositing several scroll positions captures an absolutely-positioned
    // child MORE THAN ONCE. A viewport taller than the whole section avoids it.
    const height = Math.ceil((await gallery.boundingBox())!.height) + 200;
    await page.setViewportSize({ width: 900, height });
    await expect(gallery).toBeVisible();

    await cards.nth(0).screenshot({ path: ".rx/review/eng-1270-horse-card.png" });
    await cards.nth(1).screenshot({ path: ".rx/review/eng-1270-trainer-card.png" });
    await cards.nth(2).screenshot({ path: ".rx/review/eng-1270-stablepass-card.png" });
    await gallery.screenshot({ path: ".rx/review/eng-1270-subject-gallery.png" });
  });
});
