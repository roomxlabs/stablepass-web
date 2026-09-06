import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-1027 — checkout is subscribe: recurring copy, intro coupon amounts, and
// an active member is sent to /account. Owns its own spec so sibling screenshot
// tickets do not collide on e2e/checkout.spec.ts.
//
// WHY THE BFF IS STUBBED (.rx/gotchas.md): with no STRIPE_* keys the checkout
// BFF 502s before it can resolve a price, so the populated states are
// unreachable end-to-end here. Stub the route's EXACT response shape. A stubbed
// screenshot proves the SCREEN, not the route→screen contract.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

async function seedUser(email: string): Promise<string | null> {
  try {
    const { data, error } = await admin().auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function signIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
}

async function cleanup(userId: string | null) {
  if (userId) {
    try {
      await admin().auth.admin.deleteUser(userId);
    } catch {
      /* best-effort */
    }
  }
}

async function stubSubscribe(
  page: Page,
  data: {
    unitAmount: number;
    discountAmount: number;
    amountDueNow: number;
    introMonthsRemaining: number;
    priceChangesOn: string | null;
  },
) {
  await page.route("**/api/subscription/checkout", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          clientSecret: null,
          publishableKey: null,
          mode: "subscribe",
          currency: "aud",
          subscriptionId: "sub_harness",
          ...data,
        },
      }),
    }),
  );
}

test("ENG-1027 checkout — intro subscribe states recurring charge and the price-change month", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `eng1027-intro-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    await signIn(page, email);
    await stubSubscribe(page, {
      unitAmount: 1900,
      discountAmount: 1000,
      amountDueNow: 900,
      introMonthsRemaining: 6,
      priceChangesOn: "March 2027",
    });
    await page.goto("/checkout");

    await expect(page.getByText("Order summary")).toBeVisible();
    await expect(page.getByText("Subscription · monthly")).toBeVisible();
    await expect(page.getByText("Introductory pricing")).toBeVisible();
    await expect(page.getByText(/A\$9\.00 today, then A\$19\.00 from March 2027/)).toBeVisible();
    await expect(page.getByText(/renews monthly/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Subscribe · A$9.00" })).toBeVisible();
    await expect(page.getByText("30 days of full access")).toHaveCount(0);

    await page.screenshot({ path: ".rx/review/eng-1027-checkout-intro.png", fullPage: true });
  } finally {
    await cleanup(userId);
  }
});

test("ENG-1027 checkout — standard pricing after intro months are used", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `eng1027-std-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    await signIn(page, email);
    await stubSubscribe(page, {
      unitAmount: 1900,
      discountAmount: 0,
      amountDueNow: 1900,
      introMonthsRemaining: 0,
      priceChangesOn: null,
    });
    await page.goto("/checkout");

    await expect(page.getByText("Standard pricing")).toBeVisible();
    await expect(page.getByText(/A\$19\.00 every month until you cancel/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Subscribe · A$19.00" })).toBeVisible();
    await expect(page.getByText("Introductory pricing")).toHaveCount(0);

    await page.screenshot({ path: ".rx/review/eng-1027-checkout-standard.png", fullPage: true });
  } finally {
    await cleanup(userId);
  }
});

test("ENG-1027 checkout — an active member is redirected to /account", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `eng1027-active-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    const periodEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const trialEnded = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { error } = await admin()
      .from("subscription")
      .update({ status: "active", current_period_end: periodEnd, trial_ends_at: trialEnded })
      .eq("user_id", userId!);
    test.skip(!!error, "could not seed an active subscription");

    await signIn(page, email);
    await page.goto("/checkout");
    await expect(page).toHaveURL(/\/account$/);
  } finally {
    await cleanup(userId);
  }
});
