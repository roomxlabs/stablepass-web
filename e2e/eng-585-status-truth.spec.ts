import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-585 — the UI must tell the truth about entitlement.
//
// Reproduces the exact live state the DRI hit on the Sydney project: a member
// who had PAID and was then expired by hand, i.e.
//
//     status             : active
//     current_period_end : one hour in the past
//     stripe_customer_id : set  (they converted and paid)
//     has_content_access : false          ← the server denies, correctly
//
// Against the pre-ENG-585 code that member's Account read "Status: Active",
// "30-day pass — Access to <yesterday>" and "Your access runs to <yesterday>",
// while every content screen told them their free trial had ended.
//
// See .rx/fe-harness.md for the harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// `subscription.trial_ends_at` is NOT NULL in the schema, so an `active` member
// carries the (past) date their trial ran to before they converted. `hasAccess`
// never reads it on an `active` row — but the DB will not let us omit it, and a
// fixture that lied about that would not be reproducing a real member.
const TRIAL_PAST = new Date(Date.now() - 40 * DAY).toISOString();

type SubPatch = {
  status: string;
  trial_ends_at: string;
  current_period_end: string | null;
  stripe_customer_id: string | null;
};

/**
 * A confirmed throwaway member whose `subscription` row is forced into `patch`.
 *
 * The createUser trigger provisions a trial subscription; we overwrite it with
 * the state under test. Service role, so this bypasses RLS — the point is to
 * manufacture states the app itself can never produce on demand.
 */
async function seedMember(slug: string, patch: SubPatch) {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const email = `eng585-${slug}-${Date.now()}@stablepass.test`;

  const { data: created, error: userError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (userError) throw userError;
  const userId = created.user.id;

  const { error: subError } = await admin.from("subscription").update(patch).eq("user_id", userId);
  if (subError) throw subError;

  return { email, userId };
}

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
}

// ── 1. THE BUG: paid, then expired ──────────────────────────────────────────
test("expired paid member — Account says Ended, and the wall does not mention a trial", async ({ page }) => {
  const { email } = await seedMember("expired-paid", {
    status: "active",
    trial_ends_at: TRIAL_PAST,
    current_period_end: new Date(Date.now() - HOUR).toISOString(),
    stripe_customer_id: "cus_eng585_paid",
  });

  await signIn(page, email);

  // The wall this member sees on the content screens. They PAID — so they must
  // never be told a trial ended.
  await expect(page.getByText("Your access has paused")).toBeVisible();
  await expect(page.getByRole("link", { name: "Buy 30 days" })).toBeVisible();
  await expect(page.getByText(/trial has ended/i)).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-585-wall-paid.png", fullPage: true });

  await page.goto("/account");
  // The pill that started this ticket.
  await expect(page.getByText("Ended", { exact: true })).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toHaveCount(0);
  // No past date sold as current access, and no "Extend access" on access that ended.
  await expect(page.getByText(/Your access runs to/)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Extend access" })).toHaveCount(0);
  await expect(page.getByText("No active pass")).toBeVisible();
  // The sidebar must not claim a trial is running either.
  await expect(page.getByText(/Trial · \d+ days? left/)).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-585-account-expired-paid.png", fullPage: true });
});

// ── 2. Never paid, trial expired ────────────────────────────────────────────
test("expired trial member who never paid — still told the TRIAL ended", async ({ page }) => {
  const { email } = await seedMember("expired-trial", {
    status: "trial",
    trial_ends_at: new Date(Date.now() - HOUR).toISOString(),
    current_period_end: null,
    stripe_customer_id: null,
  });

  await signIn(page, email);

  await expect(page.getByText("Your free trial has ended")).toBeVisible();
  await expect(page.getByRole("link", { name: "Get full access" })).toBeVisible();
  await page.screenshot({ path: ".rx/review/eng-585-wall-trial.png", fullPage: true });

  await page.goto("/account");
  await expect(page.getByText("Trial ended", { exact: true })).toBeVisible();
  // Never a countdown for a trial that is over, and never a negative one.
  await expect(page.getByText(/days left/)).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-585-account-expired-trial.png", fullPage: true });
});

// ── 3. THE TRAP: paid, webhook still in flight ──────────────────────────────
// `active` + `current_period_end: null` is ENTITLED, not expired. ENG-566,
// ENG-577 and ENG-582 each had to get this same null right one layer down; if
// this test ever goes red, a paying member has been locked out of their account.
test("active member with a NULL period end is entitled, not expired", async ({ page }) => {
  const { email } = await seedMember("webhook-in-flight", {
    status: "active",
    trial_ends_at: TRIAL_PAST,
    current_period_end: null,
    stripe_customer_id: "cus_eng585_inflight",
  });

  await signIn(page, email);

  // No wall at all.
  await expect(page.getByText("Your access has paused")).toHaveCount(0);
  await expect(page.getByText(/trial has ended/i)).toHaveCount(0);

  await page.goto("/account");
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("Access active")).toBeVisible();
  await expect(page.getByRole("link", { name: "Extend access" })).toBeVisible();
  await page.screenshot({ path: ".rx/review/eng-585-account-webhook-inflight.png", fullPage: true });
});

// ── 4. Control: unchanged for a member with a future period end ─────────────
test("active member with a future period end is unchanged", async ({ page }) => {
  const { email } = await seedMember("active-future", {
    status: "active",
    trial_ends_at: TRIAL_PAST,
    current_period_end: new Date(Date.now() + 20 * DAY).toISOString(),
    stripe_customer_id: "cus_eng585_future",
  });

  await signIn(page, email);
  await page.goto("/account");

  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("30-day pass")).toBeVisible();
  await expect(page.getByText(/^Access to /)).toBeVisible();
  await expect(page.getByRole("link", { name: "Extend access" })).toBeVisible();
  await page.screenshot({ path: ".rx/review/eng-585-account-active-future.png", fullPage: true });
});
