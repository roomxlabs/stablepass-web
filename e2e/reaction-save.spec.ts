import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Evidence for the reaction / save states and the captionless-post spacing.
// See .rx/fe-harness.md for the harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const BRAND_GREEN = "rgb(40, 93, 80)";

// --- At-rest appearance -------------------------------------------------------
// /preview/components renders fixed props (one card reacted, one bookmarked) and
// needs no session, so it is the right place to assert how the states LOOK.
test("a picked reaction chip is unmistakable at rest", async ({ page }) => {
  await page.goto("/preview/components");
  await expect(page.getByRole("heading", { name: "W4 shared component preview" })).toBeVisible();

  const picked = page.locator(".reactions-web button.on").first();
  await expect(picked).toBeVisible();

  const on = await picked.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, opacity: s.opacity, transform: s.transform, border: s.borderColor };
  });
  // Solid brand green, full opacity, scaled up — versus the old state, which was a
  // 1px border tint under an opaque white circle.
  expect(on.bg).toBe(BRAND_GREEN);
  expect(on.opacity).toBe("1");
  expect(on.transform).not.toBe("none");

  // Its neighbours recede, so the picked chip is the only thing that reads.
  const sibling = page.locator(".reactions-web button:not(.on)").first();
  expect(Number(await sibling.evaluate((el) => getComputedStyle(el).opacity))).toBeLessThan(1);

  // The glyph wrapper must not paint its own circle over the fill.
  const glyphBg = await picked.locator("span").evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(glyphBg).toBe("rgba(0, 0, 0, 0)");

  await page.screenshot({ path: ".rx/review/reaction-picked.png", fullPage: true });
});

test("a saved post paints green, not grey", async ({ page }) => {
  await page.goto("/preview/components");

  const saved = page.locator(".action-web.bookmarked").first();
  await expect(saved).toBeVisible();
  await expect(saved).toContainText("Saved");

  // The regression: an inline fill: currentColor outranked the stylesheet and
  // `.bookmarked` set no colour, so "saved" filled muted grey (#6B6963).
  expect(await saved.evaluate((el) => getComputedStyle(el).color)).toBe(BRAND_GREEN);
  expect(await saved.locator("svg.ic").evaluate((el) => getComputedStyle(el).fill)).toBe(BRAND_GREEN);

  const unsaved = page.locator(".action-web:not(.bookmarked)").first();
  if (await unsaved.count()) {
    expect(await unsaved.evaluate((el) => getComputedStyle(el).color)).not.toBe(BRAND_GREEN);
  }
});

// --- Interaction + spacing, against real wired state --------------------------
test("saving confirms itself, and a captionless post still separates its actions", async ({ page }) => {
  const email = `react-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Chris Waller", slug: `react-waller-${Date.now()}` })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const { data: horse, error: horseError } = await admin
    .from("horse")
    .insert({ trainer_id: trainer.id, display_name: "Mahogany", racing_name: "Mahogany", status: "active" })
    .select("id")
    .single();
  if (horseError) throw horseError;

  // The exact shape that exposed the bug: media, NO caption. post-body-web is not
  // rendered at all, so the actions row used to butt against the photo.
  const { error: postError } = await admin.from("post").insert({
    horse_id: horse.id,
    type: "photo",
    status: "published",
    body: null,
    media_url: "https://placehold.co/800x450",
    source_trainer_id: trainer.id,
    watermarked: false,
    published_at: new Date().toISOString(),
  });
  if (postError) throw postError;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto(`/horses/${horse.id}`);
    const card = page.locator(".post-web").first();
    await expect(card).toBeVisible();
    // "Recent updates" fetches client-side and renders a skeleton first, which has no
    // media/actions — wait for the real card before measuring or clicking.
    await expect(card.locator(".post-media-web")).toBeVisible();
    await expect(card.getByRole("group", { name: "React" })).toBeVisible();

    // --- Spacing: the actions row must clear the media it directly follows.
    const gap = await card.evaluate((el) => {
      const media = el.querySelector(".post-media-web");
      const actions = el.querySelector(".post-actions-web");
      if (!media || !actions) return null;
      if (media.nextElementSibling !== actions) return null; // a caption sits between
      const chip = actions.querySelector(".reactions-web button");
      return chip!.getBoundingClientRect().top - media.getBoundingClientRect().bottom;
    });
    expect(gap, "captionless post should render media directly before the actions row").not.toBeNull();
    expect(gap!).toBeGreaterThanOrEqual(12);

    // --- Save: state flips green AND a transient toast confirms it.
    const save = card.getByRole("button", { name: "Bookmark" });
    await expect(save).toContainText("Save");
    await save.click();

    const saved = card.getByRole("button", { name: "Remove bookmark" });
    await expect(saved).toBeVisible();
    await expect(saved).toContainText("Saved");
    expect(await saved.evaluate((el) => getComputedStyle(el).color)).toBe(BRAND_GREEN);

    const toast = card.getByTestId("saved-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText("Saved to your stable");

    // Let the 160ms entry animation finish so we measure/capture the settled pill.
    await toast.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    expect(await toast.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(BRAND_GREEN);
    expect(await toast.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");

    // It must sit clear of the reaction chips it is confirming, not on top of them.
    const toastBox = (await toast.boundingBox())!;
    const chipBox = (await card.locator(".reactions-web button").first().boundingBox())!;
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(chipBox.y + 1);

    await page.screenshot({ path: ".rx/review/save-confirmed.png", fullPage: false });

    // ...and it clears itself without a dismiss.
    await expect(toast).toHaveCount(0, { timeout: 6000 });

    // --- Reacting flips the chip to the solid state.
    const fire = card.getByRole("button", { name: "Fire" });
    await fire.click();
    await expect(fire).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => fire.evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe(BRAND_GREEN);
    await page.screenshot({ path: ".rx/review/reaction-and-save-live.png", fullPage: false });
  } finally {
    if (userData?.user?.id) await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
  }
});
