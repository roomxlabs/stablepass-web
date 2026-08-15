import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-571 — trial-start screen evidence (empty, validation error, submitting) plus
// a genuine end-to-end signup that proves first_name / last_name / postcode / phone
// actually land on the app_user row via handle_new_user().
//
// See .rx/fe-harness.md for the harness convention. This slice owns its OWN spec
// file rather than appending to e2e/screenshots.spec.ts — three web slices need
// screenshots this cycle, so appending would be a guaranteed collision. Same
// deliberate departure ENG-567 made in e2e/checkout.spec.ts.
//
// /start is a PUBLIC page: the first three cases need no seeded user and no auth
// at all. Only the last case touches Supabase, and it skips cleanly when local
// Supabase is unreachable so this spec is never the reason CI goes red.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
}

type Fields = {
  first?: string;
  last?: string;
  email?: string;
  phone?: string;
  postcode?: string;
  password?: string;
};

// NOTE on the postcode field: it carries maxLength={4} (from the mockup), and a
// real browser enforces that even against Playwright's fill(). So an over-long
// or space-padded postcode is literally unreachable through the UI — '  0800  '
// arrives as '  08'. That is the correct product behaviour, and it is why the
// over-long/untrimmed postcode cases live in the route unit tests (where a
// non-browser client can send them) rather than here.
async function fillForm(page: Page, f: Fields = {}) {
  await page.getByLabel("First name").fill(f.first ?? "Justin");
  await page.getByLabel("Last name").fill(f.last ?? "Alpar");
  await page.getByLabel("Email").fill(f.email ?? "member@stablepass.test");
  await page.getByLabel("Phone").fill(f.phone ?? "+61 400 000 000");
  await page.getByLabel("Postcode").fill(f.postcode ?? "3000");
  await page.getByLabel("Password").fill(f.password ?? PASSWORD);
}

test("ENG-571 trial start — the empty form shows all six fields in order", async ({ page }) => {
  await page.goto("/start");

  await expect(page.getByLabel("First name")).toBeVisible();

  const ids = await page.locator("form.auth-card input").evaluateAll((els) =>
    els.map((e) => (e as HTMLInputElement).id),
  );
  expect(ids).toEqual(["first-name", "last-name", "email", "phone", "postcode", "password"]);

  // Regression pin: a number input eats the leading zero of '0800'.
  await expect(page.getByLabel("Postcode")).toHaveAttribute("type", "text");
  await expect(page.getByLabel("Postcode")).toHaveAttribute("autocomplete", "postal-code");

  await page.screenshot({ path: ".rx/review/eng-571-empty.png", fullPage: true });
});

test("ENG-571 trial start — a bad postcode is rejected client-side with no request to the BFF", async ({ page }) => {
  let signupCalls = 0;
  await page.route("**/api/auth/signup", (route) => {
    signupCalls += 1;
    return route.abort();
  });

  await page.goto("/start");
  await fillForm(page, { postcode: "123" });
  await page.getByRole("button", { name: "Start free trial" }).click();

  // .form-error, not getByRole("alert"): Next's own #__next-route-announcer__ is
  // also role=alert, so the role selector is ambiguous in strict mode.
  await expect(page.locator(".form-error")).toHaveText("Enter a valid 4-digit Australian postcode.");
  expect(signupCalls).toBe(0);

  await page.screenshot({ path: ".rx/review/eng-571-validation.png", fullPage: true });
});

test("ENG-571 trial start — the button goes busy and disabled while the signup is in flight", async ({ page }) => {
  // Hold the response open so the in-flight state is stable enough to capture.
  await page.route("**/api/auth/signup", async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: { subscriber: null, subscription: { status: "trial", trialEndsAt: null } } }),
    });
  });

  await page.goto("/start");
  await fillForm(page);
  await page.getByRole("button", { name: "Start free trial" }).click();

  const busy = page.getByRole("button", { name: "Starting your trial…" });
  await expect(busy).toBeVisible();
  await expect(busy).toBeDisabled();

  await page.screenshot({ path: ".rx/review/eng-571-submitting.png", fullPage: true });
});

test("ENG-571 trial start — a real signup lands first/last/postcode/phone on app_user", async ({ page }) => {
  // Real signup + a cold /onboarding compile on `next dev` outruns the 30s default.
  test.setTimeout(120_000);

  const email = `eng571-${Date.now()}@stablepass.test`;
  let userId: string | null = null;

  try {
    await page.goto("/start");

    // Untrimmed name/phone (no maxLength on those) proves the client trims before
    // POSTing; '0800' proves the NT leading zero survives as text all the way to
    // the app_user row.
    await fillForm(page, {
      first: "  Justin  ",
      last: " Alpar ",
      email,
      phone: " +61 400 000 000 ",
      postcode: "0800",
    });
    await page.getByRole("button", { name: "Start free trial" }).click();

    // 201 → /onboarding. Generous timeout: against a cold `next dev` server this
    // is the first request to /onboarding, so it pays that route's compile.
    await page.waitForURL("**/onboarding", { timeout: 90_000 });

    const { data, error } = await admin()
      .from("app_user")
      .select("id,name,first_name,last_name,phone,postcode,email")
      .eq("email", email)
      .maybeSingle();

    // Skip ONLY on a connectivity error. A reachable database that returned no
    // row is a hard FAILURE, not a skip: that is precisely the symptom of
    // handle_new_user() no longer firing, and folding it into the skip would
    // let the one end-to-end proof of this ticket go green while broken.
    test.skip(!!error, `local Supabase unavailable: ${error?.message ?? ""}`);
    expect(data, "signup returned 201 but no app_user row was created").not.toBeNull();
    userId = data!.id;

    expect(data!.first_name).toBe("Justin");
    expect(data!.last_name).toBe("Alpar");
    // The trigger composes name from first/last.
    expect(data!.name).toBe("Justin Alpar");
    expect(data!.phone).toBe("+61 400 000 000");
    // Trimmed to four digits, stored as text — 800 would mean the zero was lost.
    expect(data!.postcode).toBe("0800");

    // The 30-day trial is provisioned by the same trigger.
    const { data: sub } = await admin()
      .from("subscription")
      .select("status,trial_ends_at")
      .eq("user_id", userId!)
      .maybeSingle();
    expect(sub?.status).toBe("trial");
  } finally {
    if (userId) await admin().auth.admin.deleteUser(userId).catch(() => {});
  }
});
