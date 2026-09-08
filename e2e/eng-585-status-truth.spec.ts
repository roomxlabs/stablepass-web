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
// while every content screen told them a free trial of theirs had ended (that
// last part is ENG-1008; the wall now names a pass, not a trial).
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
// ENG-999 made `trial_ends_at` NULLABLE and vestigial, and dropped `trial` from
// the status CHECK entirely. These fixtures therefore stop supplying it: a
// member carrying a trial date is a member who cannot exist any more, and
// seeding `status: 'trial'` now raises 23514 rather than reproducing anything.
const TRIAL_PAST = null;

type SubPatch = {
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  stripe_customer_id: string | null;
};

/**
 * A confirmed throwaway member whose `subscription` row is forced into `patch`.
 *
 * The createUser trigger provisions a `lapsed` subscription (ENG-999 — it used
 * to be a 30-day trial); we overwrite it with the state under test. Service role, so this bypasses RLS — the point is to
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
  // `#password`, NOT getByLabel("Password"). getByLabel matches the accessible
  // name as a case-insensitive SUBSTRING, so "Password" also matches the reveal
  // control's `aria-label="Show password"` (components/password-input.tsx) —
  // two elements, and Playwright strict mode throws. Note the button is NOT
  // inside the <label>: they are siblings in `.input-group`, so restructuring
  // the markup would not help. `{ exact: true }` would also fix it; `#password`
  // is what ENG-956/ENG-1001/ENG-1002 already use, so match them.
  //
  // This spec was already broken by it on the base branch — every test here died
  // in signIn() before reaching an assertion, which is why the stale wall string
  // ENG-1002 pinned for this ticket to break was never caught by a red run.
  await page.locator("#password").fill(PASSWORD);
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
  await expect(page.getByRole("link", { name: "Restart my subscription" })).toBeVisible();
  // ENG-1008 removed the last of that vocabulary from the wall, so this can be
  // the whole word rather than the one stale sentence — but scope it to the WALL.
  // "trial" is ordinary racing vocabulary ("barrier trial") and already appears
  // in this repo's post fixtures, so a page-wide sweep would go red the day these
  // throwaway members follow anything and the feed renders.
  await expect(page.getByTestId("access-wall").getByText(/trial/i)).toHaveCount(0);
  // They HAVE paid before, so they must not get the first-time-buyer sentence.
  await expect(page.getByText("You don't have a subscription yet")).toHaveCount(0);
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

// ── 2. Never paid ───────────────────────────────────────────────────────────
// Was "expired trial member — still told the TRIAL ended". ENG-999 retired the
// trial (`trial` is no longer a valid status) and ENG-1002 removed the trial
// wordings from the Account screen, so the member this covers is now simply
// someone who has never paid: `lapsed`, no Stripe customer.
//
// ENG-1008 is the ticket ENG-1002 predicted here. Until it landed, this test
// pinned the WALL's stale "Your free trial has ended" verbatim — deliberately,
// so that fixing the copy would turn this red and nobody could ship the fix
// while leaving the e2e lying. That has now happened, and the assertion below
// moved with it: a member with no Stripe customer is told they have no pass
// yet, not that something they never had ran out.
test("member who never paid — Account reads Ended, with no trial wording", async ({ page }) => {
  const { email } = await seedMember("never-paid", {
    status: "lapsed",
    trial_ends_at: null,
    current_period_end: null,
    stripe_customer_id: null,
  });

  await signIn(page, email);

  await expect(page.getByText("You don't have a subscription yet")).toBeVisible();
  await expect(page.getByRole("link", { name: "Get full access" })).toHaveAttribute("href", "/checkout");
  // The whole point of ENG-1008: this member has never subscribed, so nothing of
  // theirs can have "ended". Assert the absence, not just the new presence — the
  // old sentence living on elsewhere in the wall would still be the bug. Scoped
  // to the wall for the "barrier trial" reason noted above.
  await expect(page.getByTestId("access-wall").getByText(/trial/i)).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-585-wall-never-paid.png", fullPage: true });

  await page.goto("/account");
  await expect(page.getByText("Ended", { exact: true })).toBeVisible();
  await expect(page.getByText("No active pass")).toBeVisible();
  // Never a countdown, and no trial wording anywhere on this screen.
  await expect(page.getByText(/days left/)).toHaveCount(0);
  await expect(page.getByText(/trial/i)).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-585-account-never-paid.png", fullPage: true });
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
  // No wall of either kind. (No page-wide /trial/i here: this member IS entitled,
  // so the real feed renders, and "barrier trial" is legitimate post copy.)
  await expect(page.getByTestId("access-wall")).toHaveCount(0);
  await expect(page.getByText("Your access has paused")).toHaveCount(0);
  await expect(page.getByText("You don't have a subscription yet")).toHaveCount(0);

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
