import { test, expect } from "@playwright/test";

// ENG-961 evidence. Both states of the sign-in screen: with and without the
// eviction notice. See .rx/fe-harness.md.

test("signin WITHOUT a reason shows no notice (baseline)", async ({ page }) => {
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-961-signin-plain.png", fullPage: true });
});

test("signin?reason=signed-out-elsewhere explains the eviction", async ({ page }) => {
  await page.goto("/signin?reason=signed-out-elsewhere");
  const notice = page.getByRole("status");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("another device");
  await page.screenshot({ path: ".rx/review/eng-961-signin-signed-out.png", fullPage: true });
});

// The query string is attacker-controlled — an unknown reason must render nothing.
test("an unknown reason renders no notice", async ({ page }) => {
  await page.goto("/signin?reason=Your%20account%20was%20closed.%20Call%201-800-SCAM.");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-961-signin-unknown-reason.png", fullPage: true });
});
