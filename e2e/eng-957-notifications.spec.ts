// ENG-957 — /notifications, the inbox the sidebar has linked to (as a 404) all along.
//
// Real end-to-end evidence: the screen reads `notification` through this repo's
// own BFF (`app/api/notifications/*`) against the local Supabase, so the whole
// stack — RLS, the self-scoped query, the envelope, the render — runs here.
//
// States captured: empty, populated (mixed read/unread), and the sidebar chip.
// Seeded fixture data only; ids are discovered at runtime, never hardcoded.
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// See .rx/fe-harness.md for the full harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

/**
 * A confirmed throwaway member. The createUser trigger provisions the trial
 * subscription, so the member is entitled and the inbox renders rather than the
 * access wall.
 *
 * Every notification below is seeded against THIS member's id, which is also
 * what makes the self-scoping visible: a second member seeded in the same
 * database never sees these rows.
 */
async function seedMember(prefix: string) {
  const email = `${prefix}-${Date.now()}@stablepass.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error) throw error;
  return { email, userId: data.user!.id };
}

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  // `getByLabel("Password")` is AMBIGUOUS on this form — the show/hide toggle is
  // `<button aria-label="Show password">`, which Playwright's label matching also
  // resolves. Target the input by id.
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
}

test("notifications shows the empty state for a member with no alerts", async ({ page }) => {
  // A FRESH member, so the inbox is genuinely empty. Unlike a shared-table
  // screen, this needs no serial ordering or conditional skip: notifications are
  // per-member, so nobody else's seed can populate this one's inbox.
  const { email, userId } = await seedMember("eng957-empty");

  try {
    await signIn(page, email);
    await page.goto("/notifications");

    // The screen's own chrome proves it RENDERED — asserting only the absence of
    // rows would pass vacuously on the access wall or a crash (.rx/gotchas.md).
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible({
      timeout: 45_000,
    });

    // Mobile's Alerts copy, word for word. Pinned in the unit test too; this is
    // the live proof it actually reaches the screen.
    const empty = page.getByTestId("notifications-empty");
    await expect(empty).toBeVisible();
    await expect(empty).toContainText("No alerts yet");
    await expect(empty).toContainText(
      "Race-day reminders, results and new stable updates will appear here.",
    );

    // Nothing to mark read, so the action is absent rather than disabled.
    await expect(page.getByTestId("notifications-mark-all")).toHaveCount(0);
    // And no chip in the sidebar at zero unread.
    await expect(page.getByTestId("sidebar-unread-badge")).toHaveCount(0);

    await page.screenshot({ path: ".rx/review/eng-957-notifications-empty.png", fullPage: true });
  } finally {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});

test("notifications lists the member's own alerts, unread emphasised", async ({ page }) => {
  const stamp = Date.now();
  const { email, userId } = await seedMember("eng957-full");

  // A horse to deep-link into — the ONE target_type web can navigate to.
  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Chris Waller", slug: `cw-eng957-${stamp}` })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const { data: horse, error: horseError } = await admin
    .from("horse")
    .insert({
      trainer_id: trainer.id,
      display_name: `Ajax × Willow ${stamp}`,
      racing_name: "ARDENT LAD",
      training_status: "racing",
      status: "active",
    })
    .select("id")
    .single();
  if (horseError) throw horseError;

  // A SECOND member with an alert of their own. This is the self-scoping half of
  // the evidence: their row exists in the same table for the whole run and must
  // never appear on the first member's screen.
  const other = await seedMember("eng957-other");

  try {
    const { error: seedError } = await admin.from("notification").insert([
      {
        user_id: userId,
        type: "race_result",
        target_type: "horse",
        target_id: horse.id,
        title: "Ardent Lad ran 2nd",
        body: "Ardent Lad finished 2nd at Randwick.",
        read: false,
      },
      {
        user_id: userId,
        type: "race_day",
        target_type: "horse",
        target_id: horse.id,
        title: "Ardent Lad races today",
        body: "Ardent Lad jumps in Race 4 at Randwick in two hours.",
        read: false,
      },
      {
        user_id: userId,
        type: "new_post",
        target_type: "horse",
        target_id: horse.id,
        title: "New update from the stable",
        body: "A new video of Ardent Lad has been posted.",
        read: true,
      },
      {
        user_id: other.userId,
        type: "milestone",
        target_type: "horse",
        target_id: horse.id,
        title: "SOMEBODY ELSE'S ALERT",
        body: "This row belongs to another member and must never render here.",
        read: false,
      },
    ]);
    if (seedError) throw seedError;

    await signIn(page, email);
    await page.goto("/notifications");

    // Wait for the LIST with a generous budget — a cold dev server compiles the
    // route on first hit, which routinely outruns the 5s default (.rx/gotchas.md).
    await expect(page.getByTestId("notifications-list")).toBeVisible({ timeout: 45_000 });

    await expect(page.getByText("Ardent Lad ran 2nd")).toBeVisible();
    await expect(page.getByText("Ardent Lad races today")).toBeVisible();
    await expect(page.getByText("New update from the stable")).toBeVisible();

    // THE GUARDRAIL, live: the other member's row is in the table and is not on
    // this screen. An exact zero, not a "first()" — one leak is a failure.
    await expect(page.getByText("SOMEBODY ELSE'S ALERT")).toHaveCount(0);

    // Two unread → two dots, and the sidebar chip agrees.
    await expect(page.locator("[data-testid^='notifications-unread-']")).toHaveCount(2);
    await expect(page.getByTestId("sidebar-unread-badge")).toHaveText("2");
    await expect(page.getByTestId("notifications-mark-all")).toBeVisible();

    await page.screenshot({
      path: ".rx/review/eng-957-notifications-populated.png",
      fullPage: true,
    });

    // Mark all read: the dots and the chip clear TOGETHER, without a navigation.
    // The chip is the half that used to lag — it refreshes on navigation, and
    // this is the one action that changes the count without one, so a stale chip
    // would sit there claiming 2 unread beside a screen with nothing unread on it.
    await page.getByTestId("notifications-mark-all").click();
    await expect(page.locator("[data-testid^='notifications-unread-']")).toHaveCount(0);
    await expect(page.getByTestId("notifications-mark-all")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-unread-badge")).toHaveCount(0);
    await page.screenshot({
      path: ".rx/review/eng-957-notifications-all-read.png",
      fullPage: true,
    });

    // A horse-targeted row opens the horse profile — the deep link the ticket asks
    // for, and the reason routing is by `target_type` rather than by `type`.
    await page.reload();
    await expect(page.getByTestId("notifications-list")).toBeVisible({ timeout: 45_000 });
    await page.getByText("Ardent Lad ran 2nd").click();
    await page.waitForURL(`**/horses/${horse.id}`);
  } finally {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    await admin.auth.admin.deleteUser(other.userId).catch(() => {});
  }
});
