import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// See .rx/fe-harness.md for the full harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

test("signin screen renders", async ({ page }) => {
  await page.goto("/signin");
  await expect(page.getByRole("heading", { name: "Welcome back." })).toBeVisible();
  await page.screenshot({ path: ".rx/review/w1-signin.png", fullPage: true });
});

test("trial-start screen renders", async ({ page }) => {
  await page.goto("/start");
  await expect(page.getByRole("heading", { name: "Start your 30 days free." })).toBeVisible();
  await page.screenshot({ path: ".rx/review/w2-start.png", fullPage: true });
});

test("signed-in member shell renders", async ({ page }) => {
  const email = `w1-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";

  // Seed a confirmed local-Supabase user via the admin API (bypasses email
  // confirmation) so the form login below has something real to authenticate.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;

  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.waitForURL("**/explore");
  await expect(page.locator(".sidebar")).toBeVisible();
  await page.screenshot({ path: ".rx/review/w1-shell.png", fullPage: true });
});

test("onboarding screen renders", async ({ page }) => {
  const email = `w3-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Seed a trainer + a handful of active horses (service role bypasses RLS) so
  // the onboarding grid — a gated, RLS-scoped read — has something to show.
  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Chris Waller", slug: `chris-waller-${Date.now()}` })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const horseNames = ["Mahogany", "Winx", "Black Caviar", "Verry Elleegant", "Sires Son", "Northern Star"];
  const { error: horseError } = await admin
    .from("horse")
    .insert(horseNames.map((display_name) => ({ trainer_id: trainer.id, display_name, status: "active" })));
  if (horseError) throw horseError;

  // Seed a confirmed local-Supabase user via the admin API — the createUser
  // trigger provisions the trial subscription the onboarding gate requires.
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto("/onboarding");
    await expect(page.getByRole("heading", { name: "Build your stable." })).toBeVisible();

    const cards = page.locator(".horse-card-web");
    await cards.nth(0).click();
    await cards.nth(1).click();
    await cards.nth(2).click();

    await page.screenshot({ path: ".rx/review/w3-onboarding.png", fullPage: true });
  } finally {
    // Best-effort cleanup — never fail the test on teardown issues.
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }
  }
});
