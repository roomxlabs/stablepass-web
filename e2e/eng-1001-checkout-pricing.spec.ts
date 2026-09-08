import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-1001 — checkout screen evidence for the two-price world: the introductory
// band while the member still has promotional passes, and the standard-pricing
// band once the allowance is spent.
//
// Owns its OWN spec file rather than appending to e2e/checkout.spec.ts (ENG-567's)
// or e2e/screenshots.spec.ts — sibling web tickets are screenshotting this cycle
// and appending is a guaranteed collision. Same harness convention throughout:
// seed a confirmed throwaway user via the admin API, sign in through the real
// /signin form, navigate. See .rx/fe-harness.md.
//
// WHY THE BFF IS STUBBED (.rx/gotchas.md, "screenshotting a screen whose data
// needs an unconfigured third party"): with no STRIPE_* keys the checkout BFF
// 502s before it can resolve a price, so the populated states are unreachable
// end-to-end here. Both tests intercept /api/subscription/checkout and fulfil it
// with the route's EXACT response shape — including the `promoRemaining` this
// ticket adds. Everything else is real: real user, real auth, real server render.
// e2e/checkout.spec.ts keeps one unstubbed test on the genuine 502 path.
// A stubbed screenshot proves the SCREEN, not the route→screen contract; the
// route side is proved by test/subscription-routes.test.ts.
//
// THE STUB AMOUNTS ARE DELIBERATELY NOT THE REAL A$9 / A$19 — same reasoning as
// ENG-567's spec, which stubs A$1.00 for exactly this purpose: every amount on
// this screen must be DERIVED from the response, so feeding it an amount that
// appears nowhere in the catalogue makes a reintroduced price literal visible at
// a glance instead of silently agreeing with the fixture. The two amounts differ
// between the states so the screenshots also prove the band and the order summary
// read the SAME number. Which price id the counter selects is a route concern and
// is asserted there.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";

// Non-catalogue stub amounts — see the header note. Distinct per state on purpose.
const PROMO_STUB_AMOUNT = 100;
const STANDARD_STUB_AMOUNT = 250;

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

// Returns null when local Supabase is unreachable so the caller can skip rather
// than fail — this spec must never be the reason CI goes red where there is no
// Supabase.
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
  // NOT getByLabel("Password") — the reveal-password control is
  // aria-label="Show password", which the accessible-name match also picks up,
  // giving a strict-mode violation (.rx/gotchas.md). Several older specs are
  // still on the stale form.
  await page.getByRole("textbox", { name: "Password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
}

// The route's Branch-A payload. clientSecret/publishableKey are null so the
// payment slot degrades to the disabled placeholder rather than loading real
// Stripe.js — the pricing treatment is what these screenshot.
async function stubCheckout(page: Page, unitAmount: number, promoRemaining: number) {
  await page.route("**/api/subscription/checkout", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          clientSecret: null,
          publishableKey: null,
          mode: "purchase",
          unitAmount,
          currency: "aud",
          promoRemaining,
          subscriptionId: "sub_harness",
        },
      }),
    }),
  );
}

async function cleanup(userId: string | null) {
  if (userId) await admin().auth.admin.deleteUser(userId).catch(() => {});
}

test("ENG-1001 checkout — introductory pricing band while promotional passes remain", async ({ page }) => {
  const email = `eng1001-promo-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    await signIn(page, email);
    // 6 remaining = a member who has not bought a pass yet.
    await stubCheckout(page, PROMO_STUB_AMOUNT, 6);
    await page.goto("/checkout");

    await expect(page.getByText("Introductory pricing")).toBeVisible();
    await expect(page.getByText(/6 of your introductory passes are left at this price/)).toBeVisible();
    await expect(page.getByText("Standard pricing")).toHaveCount(0);

    // Every amount on the screen derives from the stubbed unitAmount: the band,
    // the order summary and the Pay button must agree. 100 → A$1.00.
    await expect(page.getByText(/This pass is A\$1\.00/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Pay A\$1\.00 · 30 days/ })).toBeVisible();
    await expect(page.getByText("Order summary")).toBeVisible();

    // ENG-999 retired the free trial — no trial copy may survive on this screen.
    await expect(page.getByText(/trial/i)).toHaveCount(0);

    await page.screenshot({ path: ".rx/review/eng-1001-checkout-promo.png", fullPage: true });
  } finally {
    await cleanup(userId);
  }
});

test("ENG-1001 checkout — standard pricing band once the allowance is spent", async ({ page }) => {
  const email = `eng1001-standard-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    await signIn(page, email);
    // 0 remaining = the counter has reached (or passed) the allowance.
    await stubCheckout(page, STANDARD_STUB_AMOUNT, 0);
    await page.goto("/checkout");

    await expect(page.getByText("Standard pricing")).toBeVisible();
    await expect(page.getByText(/used all of your introductory passes/)).toBeVisible();
    await expect(page.getByText("Introductory pricing")).toHaveCount(0);

    // 250 → A$2.50, again straight from the response.
    await expect(page.getByText(/This pass is A\$2\.50/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Pay A\$2\.50 · 30 days/ })).toBeVisible();
    await expect(page.getByText(/trial/i)).toHaveCount(0);

    await page.screenshot({ path: ".rx/review/eng-1001-checkout-standard.png", fullPage: true });
  } finally {
    await cleanup(userId);
  }
});
