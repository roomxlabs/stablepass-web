import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// Visual + behavioural evidence for the three shell stages and the real wordmark.
// See .rx/fe-harness.md for the harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function signIn(page: Page, tag: string) {
  const email = `${tag}-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;

  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
  return { admin, userId: data.user?.id };
}

const widthOf = (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => el.getBoundingClientRect().width);

// A CSS mask whose image has not decoded yet masks the element out entirely, so a
// screenshot taken the instant a breakpoint swaps wordmark <-> mark can catch an
// empty box. Force both assets into the cache before capturing.
async function brandAssetsReady(page: Page) {
  await page.evaluate(
    () =>
      Promise.all(
        ["/brand/wordmark.png", "/brand/mark.png"].map(
          (src) =>
            new Promise((resolve, reject) => {
              const img = new Image();
              img.onload = resolve;
              img.onerror = reject;
              img.src = src;
            }),
        ),
      ),
  );
}

test("desktop >=1280 keeps the full 240px sidebar and the real wordmark", async ({ page }) => {
  const { admin, userId } = await signIn(page, "shell-desktop");
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator(".sidebar")).toBeVisible();

    // The wordmark is a mask, so assert the painted box + the asset behind it
    // rather than a font — that is the whole point of the change.
    const wordmark = page.locator(".sidebar-logo .wordmark");
    await expect(wordmark).toBeVisible();
    const mask = await wordmark.evaluate((el) => getComputedStyle(el).maskImage || getComputedStyle(el).webkitMaskImage);
    expect(mask).toContain("/brand/wordmark.png");

    expect(await widthOf(page, ".sidebar")).toBeGreaterThan(200);
    await expect(page.locator(".sidebar-logo .brandmark")).toBeHidden();
    await expect(page.locator(".nav-toggle")).toBeHidden();
    await expect(page.locator(".sidebar-nav .nav-label").first()).toBeVisible();

    await brandAssetsReady(page);
    await page.screenshot({ path: ".rx/review/shell-1440-desktop.png", fullPage: false });
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});

test("tablet 900-1279 collapses to a 72px icon rail showing the S. mark", async ({ page }) => {
  const { admin, userId } = await signIn(page, "shell-tablet");
  try {
    // iPad landscape — the width that used to squeeze the feed column to ~356px
    // while the old 980px viewport query never fired.
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator(".sidebar")).toBeVisible();

    expect(await widthOf(page, ".sidebar")).toBeCloseTo(72, 0);
    await expect(page.locator(".sidebar-logo .brandmark")).toBeVisible();
    await expect(page.locator(".sidebar-logo .wordmark")).toBeHidden();
    await expect(page.locator(".nav-toggle")).toBeHidden();

    // Labels are sr-only, not removed — the accessible name must survive.
    await expect(page.getByRole("link", { name: "Horses" })).toBeAttached();

    // The whole point: the content box got its 168px back.
    const main = await widthOf(page, ".main");
    expect(main).toBeGreaterThan(940);

    await brandAssetsReady(page);
    await page.screenshot({ path: ".rx/review/shell-1024-tablet-rail.png", fullPage: false });
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});

test("phone <900 hides the sidebar behind a hamburger drawer", async ({ page }) => {
  const { admin, userId } = await signIn(page, "shell-phone");
  try {
    await page.setViewportSize({ width: 390, height: 844 });

    const toggle = page.getByRole("button", { name: "Open navigation" });
    await expect(toggle).toBeVisible();

    // The drawer slides over 180ms, so poll for the settled position rather than
    // sampling once and catching it mid-transition.
    const edge = (side: "left" | "right") => () =>
      page.locator(".sidebar").evaluate((el, s) => el.getBoundingClientRect()[s as "left"], side);

    // Closed: translated fully off-canvas, so its right edge sits at or left of 0.
    await expect.poll(edge("right")).toBeLessThanOrEqual(1);
    await brandAssetsReady(page);
    await page.screenshot({ path: ".rx/review/shell-390-phone-closed.png", fullPage: false });

    await toggle.click();
    await expect(page.getByTestId("sidebar-backdrop")).toBeVisible();
    await expect.poll(edge("left")).toBeGreaterThanOrEqual(-1);
    await expect.poll(edge("left")).toBeLessThanOrEqual(1);
    await expect(page.getByRole("link", { name: "Horses" })).toBeVisible();

    // The close button must clear the drawer, not sit on top of the wordmark.
    const closeBox = (await page.getByRole("button", { name: "Close navigation" }).boundingBox())!;
    const drawerBox = (await page.locator(".sidebar").boundingBox())!;
    expect(closeBox.x).toBeGreaterThanOrEqual(drawerBox.x + drawerBox.width);

    await brandAssetsReady(page);
    await page.screenshot({ path: ".rx/review/shell-390-phone-drawer-open.png", fullPage: false });

    // Backdrop dismisses it again. Tap to the RIGHT of the 264px drawer: the
    // backdrop covers the whole viewport, so its centre point sits under the open
    // drawer and a plain .click() would never reach it.
    await page.mouse.click(340, 400);
    await expect(page.getByTestId("sidebar-backdrop")).toHaveCount(0);
    await expect.poll(edge("right")).toBeLessThanOrEqual(1);
  } finally {
    if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});

test("the auth panel paints the same wordmark asset in cream", async ({ page }) => {
  await page.goto("/signin");
  const brand = page.locator(".auth-side-brand");
  await expect(brand).toBeVisible();

  const { mask, color } = await brand.evaluate((el) => {
    const s = getComputedStyle(el);
    return { mask: s.maskImage || s.webkitMaskImage, color: s.backgroundColor };
  });
  // Same single asset as the sidebar, recoloured purely by `color`.
  expect(mask).toContain("/brand/wordmark.png");
  expect(color).toBe("rgb(250, 247, 242)");

  await brandAssetsReady(page);
    await page.screenshot({ path: ".rx/review/shell-signin-wordmark.png", fullPage: false });
});
