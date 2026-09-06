import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-1002 — member cancel, end to end against the REAL gate.
//
// The unit suite mocks Supabase, so it can only prove the route asks for the
// right thing. Everything that actually matters about this feature is a
// property of the DATABASE and is only observable here:
//
//   * `cancel_own_subscription()` is a SECURITY DEFINER RPC and the ONLY write
//     path a member has onto `subscription`. A `.from("subscription").update()`
//     would match zero rows and return no error (ENG-582) — a mocked test
//     cannot tell those two apart, and this one can: it reads the row back.
//   * A cancelled member KEEPS ACCESS to `current_period_end`. That is
//     `has_content_access()` talking, not our UI, so it is checked by visiting a
//     gated screen and looking for the absence of the wall.
//   * `promo_passes_used` survives cancellation (a locked product decision).
//
// See .rx/fe-harness.md for the harness convention. Requires local Supabase up
// WITH stablepass-be's 20260905120000_paid_only_subscription.sql applied — the
// seeds below use `canceled`/`lapsed`, which the pre-ENG-999 CHECK rejects, and
// the RPC simply does not exist before it.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const admin = () => createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

type SubPatch = {
  status: "active" | "lapsed" | "canceled";
  current_period_end: string | null;
  stripe_customer_id?: string | null;
  promo_passes_used?: number;
  canceled_at?: string | null;
};

/**
 * A confirmed throwaway member whose `subscription` row is forced into `patch`.
 *
 * Service role, so this bypasses RLS — the point is to manufacture states the
 * app cannot produce on demand. `trial_ends_at` is deliberately never set:
 * ENG-999 made it nullable and vestigial, and a fixture that kept feeding it
 * would be reproducing a member who cannot exist any more.
 */
async function seedMember(slug: string, patch: SubPatch) {
  const sb = admin();
  const email = `eng1002-${slug}-${Date.now()}@stablepass.test`;

  const { data: created, error: userError } = await sb.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (userError) throw userError;
  const userId = created.user.id;

  const { error: subError } = await sb.from("subscription").update(patch).eq("user_id", userId);
  if (subError) throw subError;

  return { email, userId };
}

async function readSub(userId: string) {
  const { data, error } = await admin()
    .from("subscription")
    .select("status,canceled_at,cancel_reason,current_period_end,promo_passes_used")
    .eq("user_id", userId)
    .single();
  if (error) throw error;
  return data as {
    status: string;
    canceled_at: string | null;
    cancel_reason: string | null;
    current_period_end: string | null;
    promo_passes_used: number;
  };
}

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  // `#password`, NOT getByLabel("Password"): the sign-in form's show/hide
  // control is a `<button aria-label="Show password">` sitting inside the same
  // label, so getByLabel matches TWO elements and Playwright's strict mode
  // throws. Every older spec in e2e/ still uses the ambiguous form and is
  // broken by it — see .rx/gotchas.md.
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/explore");
}

// ── 1. The whole flow, and the screenshots for the PR ────────────────────────
test("active member cancels: confirm step, still entitled afterwards, row written by the RPC", async ({ page }) => {
  const periodEnd = new Date(Date.now() + 20 * DAY).toISOString();
  const { email, userId } = await seedMember("cancel-happy", {
    status: "active",
    current_period_end: periodEnd,
    stripe_customer_id: "cus_eng1002_happy",
    promo_passes_used: 3,
  });

  await signIn(page, email);
  await page.goto("/account");

  // ── ACTIVE state ──────────────────────────────────────────────────────────
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("30-day pass")).toBeVisible();
  await expect(page.getByTestId("cancel-open")).toBeVisible();
  // No trial wording survives anywhere on this screen.
  await expect(page.getByText(/trial/i)).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-1002-01-account-active.png", fullPage: true });

  // ── The confirm step is REQUIRED ──────────────────────────────────────────
  await page.getByTestId("cancel-open").click();
  await expect(page.getByTestId("cancel-confirm")).toBeVisible();
  // Nothing has been written just by opening the confirm.
  expect((await readSub(userId)).status).toBe("active");

  await page.getByLabel(/Anything you.d like to tell us/).fill("Too expensive for me right now.");
  await expect(page.getByTestId("cancel-reason-count")).toHaveText("31/500");
  await page.screenshot({ path: ".rx/review/eng-1002-02-account-confirm.png", fullPage: true });

  await page.getByTestId("cancel-confirm-submit").click();

  // ── CANCELED-BUT-ENTITLED state ───────────────────────────────────────────
  await expect(page.getByText("Access ending", { exact: true })).toBeVisible();
  await expect(page.getByText(/will not continue after that/)).toBeVisible();
  // The control is gone — there is nothing left to cancel.
  await expect(page.getByTestId("cancel-open")).toHaveCount(0);
  // Buying more days stays open to a cancelled member.
  await expect(page.getByRole("link", { name: "Extend access" })).toBeVisible();
  // The member's own comment is never rendered back to them.
  await expect(page.getByText(/Too expensive/)).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-1002-03-account-canceled.png", fullPage: true });

  // ── The row really was written (this is what a mocked test cannot prove) ──
  const row = await readSub(userId);
  expect(row.status).toBe("canceled");
  expect(row.canceled_at).not.toBeNull();
  expect(row.cancel_reason).toBe("Too expensive for me right now.");
  // The period the member paid for is untouched, and the allowance survives.
  // Compared as INSTANTS: PostgREST serialises timestamptz as `+00:00` where
  // the seed sent `Z`, so the strings differ while the moment is identical.
  expect(Date.parse(row.current_period_end!)).toBe(Date.parse(periodEnd));
  expect(row.promo_passes_used).toBe(3);

  // ── THE ACCEPTANCE CRITERION: still entitled, per the REAL gate ───────────
  // `has_content_access()` — not our UI — decides this. A cancelled member
  // inside their paid period must see content, not the wall.
  await page.goto("/explore");
  await expect(page.getByText("Your access has paused")).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-1002-04-explore-after-cancel.png", fullPage: true });
});

// ── 2. Double cancel → 409, and the first canceled_at survives ───────────────
test("cancelling twice answers 409 and does not rewrite canceled_at", async ({ page }) => {
  const { email, userId } = await seedMember("double-cancel", {
    status: "active",
    current_period_end: new Date(Date.now() + 10 * DAY).toISOString(),
  });

  await signIn(page, email);

  const first = await page.request.post("/api/subscription/cancel", {
    data: { reason: "first" },
  });
  expect(first.status()).toBe(200);
  const firstRow = await readSub(userId);
  expect(firstRow.status).toBe("canceled");

  const second = await page.request.post("/api/subscription/cancel", {
    data: { reason: "second" },
  });
  expect(second.status()).toBe(409);
  expect((await second.json()).error.code).toBe("no_active_subscription");

  const secondRow = await readSub(userId);
  expect(secondRow.canceled_at).toBe(firstRow.canceled_at);
  expect(secondRow.cancel_reason).toBe("first");
});

// ── 3. An over-long reason is refused BEFORE anything is written ─────────────
test("a 501-character reason is a 400 and writes nothing", async ({ page }) => {
  const { email, userId } = await seedMember("too-long", {
    status: "active",
    current_period_end: new Date(Date.now() + 10 * DAY).toISOString(),
  });

  await signIn(page, email);

  const res = await page.request.post("/api/subscription/cancel", {
    data: { reason: "x".repeat(501) },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error.code).toBe("validation_failed");

  const row = await readSub(userId);
  expect(row.status).toBe("active");
  expect(row.canceled_at).toBeNull();
});

// ── 4. Whitespace-only is no comment at all ─────────────────────────────────
test("a whitespace-only reason cancels with a null cancel_reason", async ({ page }) => {
  const { email, userId } = await seedMember("blank-reason", {
    status: "active",
    current_period_end: new Date(Date.now() + 10 * DAY).toISOString(),
  });

  await signIn(page, email);

  const res = await page.request.post("/api/subscription/cancel", { data: { reason: "   \n\t " } });
  expect(res.status()).toBe(200);

  const row = await readSub(userId);
  expect(row.status).toBe("canceled");
  expect(row.cancel_reason).toBeNull();
});

// ── 5. A lapsed member is offered nothing, and the RPC refuses them ─────────
test("a lapsed member sees no Cancel control and gets 409 from the route", async ({ page }) => {
  const { email } = await seedMember("lapsed", {
    status: "lapsed",
    current_period_end: new Date(Date.now() - HOUR).toISOString(),
  });

  await signIn(page, email);
  await page.goto("/account");

  await expect(page.getByText("Ended", { exact: true })).toBeVisible();
  await expect(page.getByTestId("cancel-open")).toHaveCount(0);
  await page.screenshot({ path: ".rx/review/eng-1002-05-account-lapsed.png", fullPage: true });

  const res = await page.request.post("/api/subscription/cancel", { data: {} });
  expect(res.status()).toBe(409);
});

// ── 6. Past the period end, a cancelled member is walled ────────────────────
// The other half of "keep the days you paid for": once the date passes, the
// gate stops granting. Nothing sweeps a `canceled` row — `has_content_access()`
// simply stops returning true — so this is the only thing that revokes it.
test("a cancelled member whose period has passed is walled and reads as Ended", async ({ page }) => {
  const { email } = await seedMember("canceled-expired", {
    status: "canceled",
    current_period_end: new Date(Date.now() - HOUR).toISOString(),
    canceled_at: new Date(Date.now() - 5 * DAY).toISOString(),
    // A cancelled member has necessarily PAID, so they carry a Stripe customer
    // — which is what picks the "access has paused" wall over the (stale,
    // ENG-999-orphaned) "your free trial has ended" one. Omitting it would be
    // seeding a member who cannot exist.
    stripe_customer_id: "cus_eng1002_expired",
  });

  await signIn(page, email);

  await expect(page.getByText("Your access has paused")).toBeVisible();

  await page.goto("/account");
  await expect(page.getByText("Ended", { exact: true })).toBeVisible();
  await expect(page.getByTestId("cancel-open")).toHaveCount(0);
});

// ── 7. Unauthenticated → 401, never a cancel ────────────────────────────────
test("an unauthenticated POST is 401", async ({ page }) => {
  const res = await page.request.post("/api/subscription/cancel", { data: {} });
  expect(res.status()).toBe(401);
  expect((await res.json()).error.code).toBe("unauthorized");
});
