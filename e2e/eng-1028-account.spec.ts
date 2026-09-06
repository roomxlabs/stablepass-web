import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-1028 — Subscription card states: active / cancelled / payment-failed.
// Seeded throwaway users; screenshots land in `.rx/review/` (gitignored).
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";
const DAY = 24 * 60 * 60 * 1000;

const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

type SubPatch = {
  status: "active" | "lapsed" | "canceled";
  current_period_end: string | null;
  stripe_customer_id?: string | null;
  canceled_at?: string | null;
  intro_months_used?: number;
};

async function seedMember(slug: string, patch: SubPatch) {
  const sb = admin();
  const email = `eng1028-${slug}-${Date.now()}@stablepass.test`;
  const { data: created, error: userError } = await sb.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (userError) throw userError;
  const userId = created.user.id;

  const { error: subError } = await sb.from("subscription").update(patch).eq("user_id", userId);
  if (subError) {
    // Local DB may still have `promo_passes_used` if the R1 migration is not
    // applied. Retry without the renamed column so the three visual states
    // remain screenshotable.
    const { intro_months_used: _dropped, ...rest } = patch;
    void _dropped;
    const retry = await sb.from("subscription").update(rest).eq("user_id", userId);
    if (retry.error) throw retry.error;
  }
  return { email, userId };
}

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/explore");
}

test.describe("ENG-1028 account subscription card", () => {
  test.setTimeout(120_000);

  test("active — next charge, manage card, cancel", async ({ page }) => {
    const { email } = await seedMember("active", {
      status: "active",
      current_period_end: new Date(Date.now() + 20 * DAY).toISOString(),
      stripe_customer_id: "cus_eng1028_active",
      intro_months_used: 1,
    });
    await signIn(page, email);
    await page.goto("/account");

    await expect(page.getByText("Active", { exact: true })).toBeVisible();
    await expect(page.getByText("Monthly membership")).toBeVisible();
    await expect(page.getByTestId("next-charge")).toBeVisible();
    await expect(page.getByRole("link", { name: "Manage card" })).toBeVisible();
    await expect(page.getByTestId("cancel-open")).toBeVisible();
    await expect(page.getByText(/Buy 30 days|Extend access|30-day pass/i)).toHaveCount(0);

    const card = page.getByTestId("subscription-card");
    await card.screenshot({ path: ".rx/review/eng-1028-account-active.png" });
  });

  test("cancelled — access until, no next charge, no cancel", async ({ page }) => {
    const { email } = await seedMember("canceled", {
      status: "canceled",
      current_period_end: new Date(Date.now() + 20 * DAY).toISOString(),
      stripe_customer_id: "cus_eng1028_canceled",
      canceled_at: new Date().toISOString(),
      intro_months_used: 1,
    });
    await signIn(page, email);
    await page.goto("/account");

    await expect(page.getByText("Access ending", { exact: true })).toBeVisible();
    await expect(page.getByText(/won't be charged again/)).toBeVisible();
    await expect(page.getByTestId("next-charge")).toHaveCount(0);
    await expect(page.getByTestId("cancel-open")).toHaveCount(0);

    const card = page.getByTestId("subscription-card");
    await card.screenshot({ path: ".rx/review/eng-1028-account-cancelled.png" });
  });

  test("payment-failed — not 'access ended', portal link", async ({ page }) => {
    const { email } = await seedMember("failed", {
      status: "lapsed",
      current_period_end: new Date(Date.now() - DAY).toISOString(),
      stripe_customer_id: "cus_eng1028_failed",
      canceled_at: null,
      intro_months_used: 2,
    });
    await signIn(page, email);
    await page.goto("/account");

    await expect(page.getByTestId("payment-failed")).toBeVisible();
    await expect(page.getByText(/payment didn't go through/i)).toBeVisible();
    await expect(page.getByRole("link", { name: "Update your card" })).toBeVisible();
    await expect(page.getByText(/access has ended/i)).toHaveCount(0);

    const card = page.getByTestId("subscription-card");
    await card.screenshot({ path: ".rx/review/eng-1028-account-payment-failed.png" });
  });
});
