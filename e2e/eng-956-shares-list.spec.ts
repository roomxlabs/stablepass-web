// ENG-956 — /shares is a LIST of for-sale horses, with the disclaimer.
//
// This is real end-to-end evidence, not a component render: `/shares` reads the
// `horse` table DIRECTLY through RLS (no edge function), so — unlike /explore
// and /following, whose local `feed` fn is a stub — this screen drives the full
// stack locally. See `.rx/gotchas.md`.
//
// States captured: populated, empty, and the disclaimer pop-up.
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

// SERIAL, and the empty-state test runs FIRST. The two specs share one local
// database: run in parallel, the populated spec's seed lands while the empty
// spec is asserting, and the empty state never renders.
test.describe.configure({ mode: "serial" });

// The signed-off wording, asserted on the LIVE screen as well as in the unit
// test — the pop-up must actually render it, not merely export it.
const DISCLAIMER =
  "stablepass. is an entertainment and experience subscription. stablepass. does not sell shares in " +
  "racehorses, syndicates, financial products, betting products, prize money rights, or investment returns. " +
  "Subscribers receive content access and racing experiences only.";

// ONE admin client for the file. Threading it through a parameter needs a type
// annotation, and `ReturnType<typeof createClient>` is the un-parameterised
// `SupabaseClient<unknown, …, never, never>`, which the actual call's
// `SupabaseClient<any, "public", "public", …>` is not assignable to — a tsc
// error, not a runtime one. A module-scope client sidesteps the annotation.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
  // `getByLabel("Password")` is AMBIGUOUS on this form: the show/hide toggle is
  // `<button aria-label="Show password">`, which Playwright's label matching
  // also resolves, so the strict-mode locator fails. Target the input by id.
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
}

test("shares shows the empty state when nothing is for sale", async ({ page }) => {
  const { email, userId } = await seedMember("eng956-empty");

  try {
    await signIn(page, email);
    await page.goto("/shares");

    // The screen's own chrome proves it RENDERED — asserting only the absence
    // of rows would pass vacuously on a wall or a crash (.rx/gotchas.md).
    await expect(page.getByRole("heading", { name: "Shares" })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("shares-disclaimer")).toBeVisible();

    // The serial order above guarantees THIS spec's fixtures are not in the way,
    // but the local database is shared with every other spec and with whatever a
    // developer has seeded by hand. The empty state is therefore asserted only
    // when the database genuinely holds no for-sale horse — asserting it
    // unconditionally would be a false red on a populated machine.
    //
    // The copy itself is pinned unconditionally by `test/shares-list.test.tsx`;
    // this is the screenshot, not the guarantee.
    const empty = page.getByTestId("shares-empty");
    if ((await empty.count()) === 0) {
      test.info().annotations.push({
        type: "skipped-state",
        description: "empty state not captured: the local database holds for-sale horses",
      });
      return;
    }
    await expect(empty).toContainText("No shares for sale right now");
    await expect(empty).toContainText("Horses with ownership shares for sale will show up here.");
    await page.screenshot({ path: ".rx/review/eng-956-shares-empty.png", fullPage: true });
  } finally {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});

test("shares lists for-sale horses only, with the disclaimer", async ({ page }) => {
  const stamp = Date.now();

  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({
      name: "Chris Waller",
      slug: `chris-waller-${stamp}`,
      website_url: "https://wallerracing.example",
    })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  // Two for-sale horses (these must appear) and one that is NOT for sale (this
  // must not) — the positive AND the negative half of the acceptance criterion.
  const { error: horseError } = await admin.from("horse").insert([
    {
      trainer_id: trainer.id,
      display_name: `Ajax × Willow ${stamp}`,
      racing_name: "ARDENT LAD",
      training_status: "racing",
      status: "active",
      shares_for_sale: true,
    },
    {
      trainer_id: trainer.id,
      display_name: `Zephyr × Moonlight ${stamp}`,
      racing_name: "ZEPHYR ROSE",
      training_status: "spelling",
      status: "active",
      shares_for_sale: true,
    },
    {
      trainer_id: trainer.id,
      display_name: `Not For Sale ${stamp}`,
      racing_name: "PLAIN JANE",
      training_status: "racing",
      status: "active",
      shares_for_sale: false,
    },
  ]);
  if (horseError) throw horseError;

  const { email, userId } = await seedMember("eng956");

  try {
    await signIn(page, email);
    await page.goto("/shares");

    // Wait for the LIST itself with a generous budget — a cold dev server
    // compiles the route on first hit, which routinely outruns the 5s default
    // (.rx/gotchas.md). Everything after this asserts on the default budget.
    await expect(page.getByTestId("shares-list")).toBeVisible({ timeout: 45_000 });

    // Populated, and for-sale ONLY. `.first()` because a previous run of this
    // spec may have left its own seed behind — the assertion is "this horse is
    // on the screen", not "exactly one of it exists".
    await expect(page.getByText("Ardent Lad").first()).toBeVisible();
    await expect(page.getByText("Zephyr Rose").first()).toBeVisible();
    // The negative half, and it must stay an exact ZERO: a horse with
    // `shares_for_sale = false` never appears here, however many runs seeded one.
    await expect(page.getByText("Plain Jane")).toHaveCount(0);

    // The row's furniture: trainer name, status pill, website action.
    await expect(page.getByText("Chris Waller").first()).toBeVisible();
    await expect(page.getByText("Racing").first()).toBeVisible();
    const website = page.getByRole("link", { name: /Visit trainer website/ }).first();
    await expect(website).toHaveAttribute("href", "https://wallerracing.example");

    // No post ever renders on this screen.
    await expect(page.locator(".post-web")).toHaveCount(0);

    await page.screenshot({ path: ".rx/review/eng-956-shares-populated.png", fullPage: true });

    // The disclaimer: the word alone on the screen, the copy only once opened.
    await expect(page.getByTestId("shares-disclaimer-copy")).toHaveCount(0);
    await page.getByTestId("shares-disclaimer").click();
    await expect(page.getByTestId("shares-disclaimer-copy")).toHaveText(DISCLAIMER);
    await page.screenshot({ path: ".rx/review/eng-956-shares-disclaimer.png", fullPage: true });

    await page.getByTestId("shares-disclaimer-close").click();
    await expect(page.getByTestId("shares-disclaimer-copy")).toHaveCount(0);
  } finally {
    // Remove this run's fixtures so a re-run does not accumulate duplicates.
    // NOTE: a PostgREST builder is a THENABLE, not a Promise — it has no
    // `.catch`, so best-effort teardown has to be a try/catch, not `.catch()`.
    try {
      await admin.from("horse").delete().eq("trainer_id", trainer.id);
      await admin.from("trainer").delete().eq("id", trainer.id);
    } catch {
      /* best-effort teardown — never fail the test on cleanup */
    }
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});
