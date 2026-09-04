import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-953 — password reset, end to end. See .rx/fe-harness.md for the harness
// convention (derived per-checkout port, local Supabase, throwaway seeded user).
//
// The valuable test here is the LAST one. It does not mock the recovery link:
// it asks local Supabase to mint a real one via the admin API and then opens it
// the way a member's mail client would, so the whole chain — `/reset-password`
// → `confirm/route.ts` → `verifyOtp` → session cookies → the form → a genuinely
// changed password — is exercised against the real auth server. A mocked
// version of this passes happily while the real link 404s, which is precisely
// the bug this ticket exists to fix.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
// The matching local anon key. This process is the TEST runner, not the dev
// server, so it does not inherit the env `playwright.config.ts` injects.
const ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

test("forgot-password screen renders", async ({ page }) => {
  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: "Reset your password." })).toBeVisible();
  await page.screenshot({ path: ".rx/review/eng-953-forgot.png", fullPage: true });
});

test("forgot-password confirms without confirming the account exists", async ({ page }) => {
  await page.goto("/forgot-password");
  // Deliberately an address with NO account. The screen must look exactly the
  // same as it would for a real member — that is the no-enumeration rule as the
  // member actually experiences it.
  await page.getByLabel("Email").fill("definitely-not-a-member@stablepass.test");
  await page.getByRole("button", { name: "Send reset link" }).click();

  await expect(page.getByRole("heading", { name: "Check your inbox." })).toBeVisible();
  const body = await page.locator(".auth-card").innerText();
  expect(body).toContain("If");
  for (const leak of ["no account", "not registered", "doesn't exist", "we found"]) {
    expect(body.toLowerCase()).not.toContain(leak);
  }
  await page.screenshot({ path: ".rx/review/eng-953-forgot-sent.png", fullPage: true });
});

test("a dead reset link explains itself instead of 404ing", async ({ page }) => {
  // The state a member lands on with a day-old email. Before this ticket this
  // URL was a 404 for every visitor.
  await page.goto("/reset-password?error=access_denied&error_code=otp_expired");
  await expect(page.getByRole("heading", { name: "This link has expired." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Send me a new link" })).toHaveAttribute(
    "href",
    "/forgot-password",
  );
  await page.screenshot({ path: ".rx/review/eng-953-reset-expired.png", fullPage: true });
});

test("a real recovery link sets a new password and signs the member in", async ({ page }) => {
  const email = `eng953-${Date.now()}@stablepass.test`;
  const originalPassword = "harness-password-123!";
  const newPassword = "harness-password-456!";

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { error: createError } = await admin.auth.admin.createUser({
    email,
    password: originalPassword,
    email_confirm: true,
  });
  if (createError) throw createError;

  // A genuine recovery token from the real auth server — the same one the email
  // template would embed as `{{ .TokenHash }}`.
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
  });
  if (linkError) throw linkError;
  const tokenHash = link.properties?.hashed_token;
  expect(tokenHash, "local Supabase returned no recovery token").toBeTruthy();

  await page.goto(`/reset-password?token_hash=${tokenHash}&type=recovery`);

  // The secret must have been spent by the confirm handler and left behind: the
  // form the member types into is on a clean URL.
  await expect(page.getByRole("heading", { name: "Set a new password." })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await page.screenshot({ path: ".rx/review/eng-953-reset-form.png", fullPage: true });

  // Validation, on the real screen.
  await page.getByLabel("New password", { exact: true }).fill("short");
  await page.getByLabel("Confirm new password").fill("short");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.locator(".form-error")).toContainText("at least 8 characters");

  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill("different-password-789!");
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page.locator(".form-error")).toContainText("don't match");

  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password").fill(newPassword);
  await page.getByRole("button", { name: "Save new password" }).click();

  // Signed in and delivered to the feed — no second sign-in step.
  await page.waitForURL("**/explore");

  // And the password genuinely changed on the auth server, not just in the UI.
  // BOTH directions matter: asserting only that the old password stopped
  // working would also pass if the update had simply corrupted the credential.
  const anon = createClient(SUPABASE_URL, ANON_KEY);

  const { error: oldPasswordError } = await anon.auth.signInWithPassword({
    email,
    password: originalPassword,
  });
  expect(oldPasswordError, "the OLD password must no longer work").toBeTruthy();

  const { data: newSession, error: newPasswordError } = await anon.auth.signInWithPassword({
    email,
    password: newPassword,
  });
  expect(newPasswordError, "the NEW password must work").toBeNull();
  expect(newSession.user?.email).toBe(email);
});

test("a signed-in member cannot use /reset-password to skip the email check", async ({ page }) => {
  // The takeover all three reviewers reproduced: before the recovery-marker
  // gate, ANY live session rendered the new-password form, and `updateUser`
  // needs no current password. Single-device login (guardrail #5) then locks
  // the real member out. This proves the gate holds against a REAL browser
  // session, not a mocked one.
  const email = `eng953-signedin-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;

  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");

  // Signed in, but never touched a recovery link.
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "This link has expired." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Set a new password." })).toHaveCount(0);
});

test("a link opened on the wrong device gets advice, not a dead end", async ({ page }) => {
  // A PKCE (?code=) link can only be spent by the browser that requested it.
  // Telling this member the link "expired" sends them round a request loop that
  // can never succeed, so this state has its own screen.
  await page.goto("/reset-password?state=devicemismatch");
  await expect(
    page.getByRole("heading", { name: "Open this link where you asked for it." }),
  ).toBeVisible();
  await page.screenshot({ path: ".rx/review/eng-953-reset-wrong-device.png", fullPage: true });
});
