import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-567 — checkout screen evidence (purchase, early renewal, Stripe-unconfigured).
// See .rx/fe-harness.md for the harness convention; follows the seed-via-admin-API
// → sign in through the real /signin form → navigate pattern used by
// e2e/screenshots.spec.ts. This slice owns its OWN spec file rather than
// appending to e2e/screenshots.spec.ts (three web slices need screenshots this
// cycle — appending would be a guaranteed collision).
//
// WHY TWO OF THESE STUB THE BFF RESPONSE:
// There are no Stripe sandbox keys in this environment yet (ENG-565 is not done),
// so /api/subscription/checkout returns 502 stripe_unavailable before it can ever
// retrieve the price — meaning the real amounts and `mode: "renewal"` are simply
// unreachable end-to-end here. To still prove the SCREEN is correct, the purchase
// and renewal cases intercept the BFF call and fulfil it with the exact contract
// shape the route returns. Everything else is real: real user, real auth, real
// server render. The third test stubs NOTHING and exercises the genuine 502 path.
//
// Both stubbed fixtures use unitAmount 100 ("A$1.00") deliberately — the sandbox
// price. If a price literal were ever reintroduced into the component, these
// screenshots would show A$19.00 and the drift would be visible at a glance.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

// Seeds a confirmed throwaway user (the createUser trigger provisions the trial
// subscription the screen reads). Returns null when local Supabase is unreachable
// so the caller can skip rather than fail — this spec must never be the reason CI
// goes red in an environment with no Supabase.
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
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
}

async function cleanup(userId: string | null) {
  if (userId) await admin().auth.admin.deleteUser(userId).catch(() => {});
}

test("ENG-567 checkout — purchase mode renders the 30-day pass summary and GST from the live price", async ({ page }) => {
  const email = `eng567-purchase-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    await signIn(page, email);

    // The contract shape the route returns for Branch A. clientSecret/publishableKey
    // are null so the payment slot degrades to the disabled placeholder instead of
    // trying to load real Stripe.js — the ORDER SUMMARY is what this screenshots.
    await page.route("**/api/subscription/checkout", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            clientSecret: null,
            publishableKey: null,
            mode: "purchase",
            unitAmount: 100,
            currency: "aud",
          },
        }),
      }),
    );

    await page.goto("/checkout");

    await expect(page.getByText("Order summary")).toBeVisible();
    // `exact` — the header sub-copy also contains "30 days of full access".
    await expect(page.getByText("30 days of full access", { exact: true })).toBeVisible();
    await expect(page.getByText("Includes GST")).toBeVisible();
    // Derived from unitAmount, never hardcoded: 100 → A$1.00, GST 100/11 → A$0.09.
    await expect(page.getByText("A$0.09")).toBeVisible();
    await expect(page.getByRole("button", { name: /Pay A\$1\.00 · 30 days/ })).toBeVisible();
    // The removed behaviour must be gone from the rendered screen.
    await expect(page.getByText(/renews monthly/i)).toHaveCount(0);

    await page.screenshot({ path: ".rx/review/eng-567-checkout-purchase.png", fullPage: true });
  } finally {
    await cleanup(userId);
  }
});

test("ENG-567 checkout — renewal mode renders the extend copy with both dates", async ({ page }) => {
  const email = `eng567-renewal-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    // Flip the seeded trial to active with a period end 10 days out — this is what
    // makes the REAL route take Branch B; the stub below mirrors what it returns.
    const currentPeriodEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await admin()
      .from("subscription")
      .update({ status: "active", current_period_end: currentPeriodEnd })
      .eq("user_id", userId!);
    test.skip(!!error, "could not seed an active subscription");

    await signIn(page, email);

    // Branch B's contract shape. newPeriodEnd = current_period_end + 30 days,
    // computed the same advance-only way the route computes it.
    const newPeriodEnd = new Date(Date.parse(currentPeriodEnd) + 30 * 24 * 60 * 60 * 1000).toISOString();
    await page.route("**/api/subscription/checkout", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            clientSecret: null,
            publishableKey: null,
            mode: "renewal",
            unitAmount: 100,
            currency: "aud",
            currentPeriodEnd,
            newPeriodEnd,
          },
        }),
      }),
    );

    await page.goto("/checkout");

    // An active member is no longer redirected to /account — early renewal is a
    // first-class flow now, so the checkout screen must actually be reachable.
    await expect(page).toHaveURL(/\/checkout$/);
    await expect(page.getByText(/Your access currently ends/)).toBeVisible();
    await expect(page.getByText(/Paying now extends it to/)).toBeVisible();
    await expect(page.getByText("Includes GST")).toBeVisible();

    await page.screenshot({ path: ".rx/review/eng-567-checkout-renewal.png", fullPage: true });
  } finally {
    await cleanup(userId);
  }
});

test("ENG-567 checkout — with no Stripe keys the full layout still renders with the disabled placeholder", async ({ page }) => {
  const email = `eng567-nostripe-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    await signIn(page, email);

    // NOTHING is stubbed here — this is the genuine end-to-end 502
    // stripe_unavailable path that keeps the screen screenshot-able with no keys.
    await page.goto("/checkout");

    await expect(page.getByText("Order summary")).toBeVisible();
    await expect(page.getByText("30 days of full access", { exact: true })).toBeVisible();
    await expect(page.getByText(/connect a Stripe key to enable checkout/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Pay/ })).toBeDisabled();

    await page.screenshot({ path: ".rx/review/eng-567-checkout-no-stripe.png", fullPage: true });
  } finally {
    await cleanup(userId);
  }
});
