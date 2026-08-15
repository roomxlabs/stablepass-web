import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-570 — expiry banner screen evidence (mounted in the (member) shell so it
// shows on every member screen, not just Account). See .rx/fe-harness.md for
// the harness convention; follows the seed-via-admin-API → sign in through the
// real /signin form → navigate pattern used by e2e/screenshots.spec.ts, and the
// throwaway-user + service-role update pattern from e2e/checkout.spec.ts. This
// slice owns its OWN spec file rather than appending to e2e/screenshots.spec.ts
// (three web slices need screenshots this cycle — appending would be a
// guaranteed collision).
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

// Seeds a confirmed throwaway user (the createUser trigger provisions a 30-day
// trial subscription). Returns null when local Supabase is unreachable so the
// caller can skip rather than fail — this spec must never be the reason CI
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

async function setTrialEndsAt(userId: string, trialEndsAt: string) {
  await admin().from("subscription").update({ trial_ends_at: trialEndsAt }).eq("user_id", userId);
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

test("ENG-570 expiry banner — a trial member 5 days out sees the banner on every member screen", async ({ page }) => {
  const email = `eng570-5days-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    // 4.5 days out so Math.ceil lands exactly on 5.
    const trialEndsAt = new Date(Date.now() + 4.5 * 24 * 60 * 60 * 1000).toISOString();
    await setTrialEndsAt(userId!, trialEndsAt);

    await signIn(page, email);

    await page.goto("/explore");
    await expect(page.getByText("Your access ends in 5 days.")).toBeVisible();
    const renewLink = page.getByRole("link", { name: "Renew now" });
    await expect(renewLink).toBeVisible();
    await expect(renewLink).toHaveAttribute("href", "/checkout");
    await page.screenshot({ path: ".rx/review/eng-570-banner-explore.png", fullPage: true });

    // Proves the banner is mounted in the shell, not per-screen.
    await page.goto("/account");
    await expect(page.getByText("Your access ends in 5 days.")).toBeVisible();
    await page.screenshot({ path: ".rx/review/eng-570-account.png", fullPage: true });
  } finally {
    await cleanup(userId);
  }
});

test("ENG-570 expiry banner — a trial member 8 days out sees no banner", async ({ page }) => {
  const email = `eng570-8days-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    await signIn(page, email);

    // POSITIVE CONTROL FIRST. The banner is a client island that only mounts
    // after hydration, so a bare `toHaveCount(0)` straight after a goto() can
    // pass for the wrong reason — the page simply had not hydrated yet. Proving
    // the banner DOES appear in this browser context, then moving the date out
    // of the window, is what makes the absence below mean something. (See the
    // "all-negative assertions pass vacuously" note in .rx/gotchas.md.)
    await setTrialEndsAt(userId!, new Date(Date.now() + 4.5 * 24 * 60 * 60 * 1000).toISOString());
    await page.goto("/explore");
    await expect(page.getByTestId("expiry-banner")).toBeVisible();

    // 7.5 days out so Math.ceil lands exactly on 8, outside the inclusive-7 window.
    await setTrialEndsAt(userId!, new Date(Date.now() + 7.5 * 24 * 60 * 60 * 1000).toISOString());
    await page.reload();
    // Anchored: the banner rendered on the previous load of this same page, so
    // its absence now is the 8-day rule, not an unhydrated document.
    await expect(page.getByTestId("expiry-banner")).toHaveCount(0);
  } finally {
    await cleanup(userId);
  }
});

test("ENG-570 expiry banner — dismissing hides it for the session", async ({ page }) => {
  const email = `eng570-dismiss-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    const trialEndsAt = new Date(Date.now() + 4.5 * 24 * 60 * 60 * 1000).toISOString();
    await setTrialEndsAt(userId!, trialEndsAt);

    await signIn(page, email);

    await page.goto("/explore");
    await expect(page.getByText("Your access ends in 5 days.")).toBeVisible();

    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("expiry-banner")).toHaveCount(0);

    // sessionStorage survives navigation in the same context.
    await page.goto("/saved");
    await expect(page.getByTestId("expiry-banner")).toHaveCount(0);
    // The dismissal is the REASON it is absent here — the key is still stored
    // and still points at this period's end. Compared as an INSTANT, not as a
    // string: Postgres hands the timestamp back as `…+00:00` where the value we
    // sent was `…Z`, so an exact string match would be asserting the driver's
    // formatting rather than the behaviour.
    const stored = await page.evaluate(() => window.sessionStorage.getItem("expiry-dismissed"));
    expect(stored).not.toBeNull();
    expect(Date.parse(stored!)).toBe(Date.parse(trialEndsAt));
    await page.screenshot({ path: ".rx/review/eng-570-banner-dismissed.png", fullPage: true });

    // POSITIVE CONTROL for the two assertions above: clear the dismissal and the
    // banner must come back on the very same screen. Without this, "absent"
    // could just mean "this page never hydrated" — and it doubles as the
    // re-arm proof, since a stored key that no longer matches `endsAt` is
    // exactly what a renewal produces.
    await page.evaluate(() => window.sessionStorage.removeItem("expiry-dismissed"));
    await page.reload();
    await expect(page.getByTestId("expiry-banner")).toBeVisible();
  } finally {
    await cleanup(userId);
  }
});

// The other half of this slice: the Account profile form now edits the
// STRUCTURED name pair. This is the end-to-end proof of the epic's central
// convention — `name` is NOT a generated column, it is a plain column kept in
// sync by ENG-566's `app_user_name_sync` BEFORE trigger — so writing only
// first/last through the BFF must leave `name` reading "First Last" for the
// admin queries and the released mobile build that still read it.
test("ENG-570 account profile — first/last render populated, save round-trips, and the trigger keeps `name` in sync", async ({ page }) => {
  const email = `eng570-profile-${Date.now()}@stablepass.test`;
  const userId = await seedUser(email);
  test.skip(userId === null, "local Supabase unavailable");

  try {
    // Seed the structured pair the way ENG-566's backfill leaves a real member.
    const seeded = await admin()
      .from("app_user")
      .update({ first_name: "Justin", last_name: "Alpar", phone: "+61 431 581 526" })
      .eq("id", userId!);
    test.skip(!!seeded.error, "could not seed the member's name");

    await signIn(page, email);
    await page.goto("/account");

    // Populated from first_name/last_name — never split client-side from `name`.
    await expect(page.getByLabel("First name")).toHaveValue("Justin");
    await expect(page.getByLabel("Last name")).toHaveValue("Alpar");
    // The single Name field is gone.
    await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: ".rx/review/eng-570-account-profile-populated.png", fullPage: true });

    await page.getByLabel("First name").fill("Justine");
    await page.getByLabel("Last name").fill("Alpari");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    // The BFF wrote ONLY first_name/last_name; `name` is the trigger's work.
    const { data } = await admin()
      .from("app_user")
      .select("first_name,last_name,name")
      .eq("id", userId!)
      .single();
    expect(data?.first_name).toBe("Justine");
    expect(data?.last_name).toBe("Alpari");
    expect(data?.name).toBe("Justine Alpari");
  } finally {
    await cleanup(userId);
  }
});
