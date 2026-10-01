import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-1328 (Pricing v2 W3) — /checkout and /account for a trial-eligible member,
// a paying member and a trialling member. Owns its own spec so sibling
// screenshot tickets do not collide.
//
// TWO MODES, chosen by the environment:
//   * STRIPE_SECRET_KEY (sk_test_…) + STRIPE_PRICE_ID_STANDARD set → the
//     eligible-checkout test runs the REAL route against the Stripe sandbox,
//     CARD FIRST: a real SetupIntent secret and the real Payment Element on it,
//     no Subscription in Stripe until a test card is confirmed, then exactly one
//     `trialing` Subscription with that card as its default. That proves
//     route → screen → Stripe, not just the screen. The Stripe objects it
//     creates are removed afterwards.
//   * No Stripe env → the checkout BFF is stubbed with the route's exact
//     response shape (a stubbed screenshot proves the SCREEN only).
// /account reads the Stripe price server-side; without Stripe env it prints
// "the standard monthly price" instead of an amount, which is the designed
// degradation.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const PASSWORD = "harness-password-123!";
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const LIVE_STRIPE = STRIPE_KEY.startsWith("sk_test_") && !!process.env.STRIPE_PRICE_ID_STANDARD;

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

async function seedUser(email: string): Promise<string | null> {
  try {
    const { data, error } = await admin().auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
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

// Sandbox only (sk_test_ enforced above): delete the Customer the real route
// created for this seeded email, which also cancels its Subscription.
async function cleanupStripe(email: string) {
  if (!LIVE_STRIPE) return;
  const auth = { Authorization: `Basic ${Buffer.from(`${STRIPE_KEY}:`).toString("base64")}` };
  const res = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=10`, { headers: auth });
  const body = (await res.json()) as { data?: { id: string }[] };
  for (const c of body.data ?? []) {
    await fetch(`https://api.stripe.com/v1/customers/${c.id}`, { method: "DELETE", headers: auth });
  }
}

// Sandbox read-back of what the real route created for this seeded email.
async function stripeSubs(email: string): Promise<{ id: string; status: string; default_payment_method: string | null; trial_end: number | null }[]> {
  const auth = { Authorization: `Basic ${Buffer.from(`${STRIPE_KEY}:`).toString("base64")}` };
  const res = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=10`, { headers: auth });
  const customers = ((await res.json()) as { data?: { id: string }[] }).data ?? [];
  const out: { id: string; status: string; default_payment_method: string | null; trial_end: number | null }[] = [];
  for (const c of customers) {
    const r = await fetch(`https://api.stripe.com/v1/subscriptions?customer=${c.id}&status=all`, { headers: auth });
    for (const sub of ((await r.json()) as { data?: typeof out }).data ?? []) {
      out.push({ id: sub.id, status: sub.status, default_payment_method: sub.default_payment_method, trial_end: sub.trial_end });
    }
  }
  return out;
}

async function stubCheckout(page: Page, data: Record<string, unknown>) {
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
          priceChangesOn: null,
          subscriptionId: "sub_harness",
          ...data,
        },
      }),
    }),
  );
}

const sydneyDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Sydney" });

test("ENG-1328 checkout — trial-eligible member: A$0.00 today, free until <date>", async ({ page }) => {
  test.setTimeout(180_000);
  const email = `eng1328-eligible-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    await signIn(page, email);
    if (!LIVE_STRIPE) {
      await stubCheckout(page, {
        intentType: "setup",
        unitAmount: 999,
        amountDueNow: 0,
        trialEndsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
    }
    const checkoutResponse = page.waitForResponse("**/api/subscription/checkout");
    await page.goto("/checkout");
    const body = await (await checkoutResponse).json();
    if (LIVE_STRIPE) {
      // The real route against the sandbox: a trial answers with a SetupIntent.
      expect(body.data.intentType).toBe("setup");
      expect(String(body.data.clientSecret)).toMatch(/^seti_/);
      expect(body.data.amountDueNow).toBe(0);
    }
    const trialEnd = sydneyDate(body.data.trialEndsAt);

    await expect(page.getByTestId("pricing-band")).toContainText("Free trial");
    await expect(page.getByTestId("pricing-band")).toContainText(`A$0.00 today. Free until ${trialEnd}, then A$9.99 per month`);
    await expect(page.getByTestId("summary-trial")).toContainText(`Until ${trialEnd}`);
    await expect(page.getByRole("button", { name: /Start free trial · A\$0\.00 today/ })).toBeVisible();
    if (LIVE_STRIPE) {
      // The Payment Element really mounted on the SetupIntent secret.
      await expect(page.locator('[data-testid="payment-element-slot"] iframe').first()).toBeVisible({ timeout: 30_000 });
      await page.waitForTimeout(2_000);
    }
    await page.screenshot({ path: ".rx/review/eng-1328-checkout-trial.png", fullPage: true });

    if (LIVE_STRIPE) {
      // CARD FIRST, end to end against the sandbox: nothing exists in Billing
      // until the card is confirmed; then the second POST starts the trial on it.
      expect(await stripeSubs(email)).toEqual([]);
      const frame = page.frameLocator('[data-testid="payment-element-slot"] iframe').first();
      const cardTab = frame.getByRole("button", { name: /^Card$/ });
      if (await cardTab.count()) await cardTab.first().click();
      await frame.getByPlaceholder(/1234 1234 1234 1234/).fill("4242424242424242");
      await frame.getByPlaceholder(/MM \/ YY/).fill("12 / 34");
      await frame.getByPlaceholder(/CVC/).fill("123");
      const postcode = frame.getByPlaceholder(/(ZIP|Postal|Postcode)/i);
      if (await postcode.count()) await postcode.first().fill("2000");
      const started = page.waitForResponse(
        (r) => r.url().endsWith("/api/subscription/checkout") && r.request().method() === "POST",
      );
      await page.getByRole("button", { name: /Start free trial/ }).click();
      const startBody = await (await started).json();
      expect(startBody.data.started).toBe(true);
      const subs = await stripeSubs(email);
      expect(subs).toHaveLength(1);
      expect(subs[0].status).toBe("trialing");
      expect(subs[0].default_payment_method).toMatch(/^pm_/);
      console.log(`[eng-1328] live trial started: ${JSON.stringify(subs[0])}`);
    }
  } finally {
    await cleanupStripe(email);
    await cleanup(userId);
  }
});

test("ENG-1328 checkout — member who already had a trial: A$9.99 today", async ({ page }) => {
  test.setTimeout(120_000);
  const email = `eng1328-paying-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    await signIn(page, email);
    await stubCheckout(page, { intentType: "payment", unitAmount: 999, amountDueNow: 999, trialEndsAt: null });
    await page.goto("/checkout");

    await expect(page.getByTestId("pricing-band")).toContainText("Monthly membership");
    await expect(page.getByTestId("pricing-band")).toContainText("A$9.99 today, then A$9.99 per month");
    await expect(page.getByRole("button", { name: "Subscribe · A$9.99" })).toBeVisible();
    await expect(page.getByText("Free trial")).toHaveCount(0);
    await page.screenshot({ path: ".rx/review/eng-1328-checkout-no-trial.png", fullPage: true });
  } finally {
    await cleanup(userId);
  }
});

for (const periodType of ["trial", "normal"] as const) {
  test(`ENG-1328 account — ${periodType === "trial" ? "trialling" : "paying"} member`, async ({ page }) => {
    test.setTimeout(120_000);
    const email = `eng1328-account-${periodType}-${Date.now()}@stablepass.test`;
    const userId = await seedUser(email);
    test.skip(userId === null, "local Supabase unavailable");

    try {
      const periodEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
      const { error } = await admin()
        .from("subscription")
        .update({ status: "active", current_period_end: periodEnd, period_type: periodType, stripe_customer_id: "cus_harness", provider: "stripe" })
        .eq("user_id", userId!);
      test.skip(!!error, `could not seed the subscription row: ${error?.message}`);

      await signIn(page, email);
      await page.goto("/account");
      const end = sydneyDate(periodEnd);
      const price = LIVE_STRIPE ? "A$9.99 per month" : "the standard monthly price";

      if (periodType === "trial") {
        await expect(page.getByTestId("trial-until")).toContainText(`Free until ${end}`);
        await expect(page.getByTestId("change-over")).toContainText(price);
        await expect(page.getByTestId("next-charge")).toHaveCount(0);
      } else {
        await expect(page.getByTestId("next-charge")).toContainText(LIVE_STRIPE ? `A$9.99 on ${end}` : `On ${end}`);
        await expect(page.getByTestId("trial-until")).toHaveCount(0);
        await expect(page.getByTestId("change-over")).toHaveCount(0);
      }
      await page.getByTestId("subscription-card").screenshot({ path: `.rx/review/eng-1328-account-${periodType}.png` });
    } finally {
      await cleanup(userId);
    }
  });
}
