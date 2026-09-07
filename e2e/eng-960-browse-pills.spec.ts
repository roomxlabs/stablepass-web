// ENG-960 — a FOR-SALE-ONLY stable is not an empty stable.
//
// Before this ticket, `/horses` and the trainer roster both excluded any horse
// with `shares_for_sale: true`. A stable whose every horse is for sale
// therefore rendered an EMPTY grid, an empty "Horses in this stable" roster
// and a "0 horses" trainer card — a live bug, not a design choice. R8 reversed
// the exclusion: for-sale horses fold back into "All" everywhere except the
// dedicated Shares tab (see the notes in horses-grid.tsx, stable-horses.tsx /
// trainers/[id]/page.tsx, and trainers-grid.tsx).
//
// This spec seeds exactly that scenario end to end — a trainer with THREE
// active, all-for-sale horses and nothing else — and asserts:
//   - `/horses` "All" shows all three.
//   - `/horses` "Following" (browse-filter, NOT the Explore segment) shows
//     exactly the one horse this member follows.
//   - the Following empty state, for a member who follows nothing.
//   - the trainer's own roster lists all three, and the Horses stat reads 3.
//   - the trainer's card on `/trainers` reads "3 horses".
//
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

// ONE admin client for the file — see eng-956-shares-list.spec.ts for why a
// module-scope client sidesteps the `ReturnType<typeof createClient>` tsc gap.
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

// `.browse-pill` (app/globals.css) animates `background`/`color`/`border-color`
// over 150ms on the `is-active` class flip. React flips the class — and any
// copy that depends on it — INSTANTLY, so a screenshot taken right after a
// click can catch the pill mid-fade: a washed-out in-between green, or (at
// t≈0) the OLD pill still fully painted active while the new copy has already
// switched. Neither is the app's real, settled appearance. Wait for the
// computed background colour itself to settle before ever screenshotting a
// pill that was just toggled.
const BRAND_GREEN = "rgb(40, 93, 80)"; // --brand-green #285D50 (.browse-pill.is-active)
// --cream-dark #F1ECE3, the .browse-pill resting fill. NOT --cream: the page
// body is --cream, so a --cream pill would be invisible as a fill (see the
// BROWSE FILTER PILLS block in app/globals.css).
const PILL_REST = "rgb(241, 236, 227)";

async function expectSettledPillColor(locator: import("@playwright/test").Locator, expected: string) {
  await expect(async () => {
    const bg = await locator.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe(expected);
  }).toPass({ timeout: 2_000 });
}

test("ENG-960 a for-sale-only stable's three horses show on All, on Following, and on the roster", async ({
  page,
}) => {
  const stamp = Date.now();

  // Name-prefixed "0000 " deliberately: `/trainers` sorts A-Z and caps at
  // `BROWSE_PAGE_SIZE` (100), and the shared local database already holds 200+
  // leftover fixture trainers from other specs (by convention, not cleaned up)
  // whose names sort well ahead of "R" — see lib/browse.ts. A digit prefix
  // sorts before every existing letter-led fixture, so this trainer's card is
  // guaranteed to land inside the cap regardless of what else has accumulated.
  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({
      name: "0000 Ruddy Racing ENG960",
      slug: `ruddy-racing-eng960-${stamp}`,
      stable_name: "Ruddy Racing",
      location: "Scone, NSW",
      status: "active",
    })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  // THREE horses, ALL for sale, ALL active — this stable has NO non-sale horse
  // at all. That is the whole point: before this ticket, "all for sale" meant
  // "all excluded", and the roster/grid rendered empty.
  const horseNames = [
    `ENG960 Firstborn ${stamp}`,
    `ENG960 Second Wind ${stamp}`,
    `ENG960 Third Chance ${stamp}`,
  ];
  const { data: horses, error: horseError } = await admin
    .from("horse")
    .insert(
      horseNames.map((display_name) => ({
        trainer_id: trainer.id,
        display_name,
        status: "active",
        shares_for_sale: true,
      })),
    )
    .select("id, display_name");
  if (horseError) throw horseError;
  const rows = horses!;
  const followedHorse = rows[0];

  const { email, userId } = await seedMember("eng960");

  // Content access — the createUser trigger provisions the trial subscription
  // the browse gate reads (see W6/W7 note in screenshots.spec.ts); no extra
  // subscription row is inserted here, matching that convention.

  // The user follows exactly ONE of the three for-sale horses.
  const { error: followError } = await admin
    .from("follow")
    .insert({ user_id: userId, horse_id: followedHorse.id, trainer_id: null });
  if (followError) throw followError;

  try {
    await signIn(page, email);

    // --- /horses, "All" pill active: all three for-sale horses visible. -----
    await page.goto("/horses");
    await expect(page.getByRole("heading", { name: "Horses" })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("browse-filter-all")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("browse-filter-following")).toHaveAttribute("aria-pressed", "false");

    for (const name of horseNames) {
      await expect(page.getByText(name).first()).toBeVisible({ timeout: 45_000 });
    }
    await page.screenshot({ path: ".rx/review/eng-960-horses-all.png", fullPage: true });

    // --- /horses, Following pill clicked: exactly the one followed horse. ---
    const followingPill = page.getByRole("button", { name: "Show following" });
    const allPill = page.getByTestId("browse-filter-all");
    await followingPill.click();
    await expect(page.getByTestId("browse-filter-following")).toHaveAttribute("aria-pressed", "true");
    await expect(allPill).toHaveAttribute("aria-pressed", "false");
    // The class flips instantly; the pill's background is a 150ms CSS
    // transition. Wait for BOTH pills to reach their real, settled colour —
    // Following solid brand-green, All back to cream — before capturing.
    await expectSettledPillColor(followingPill, BRAND_GREEN);
    await expectSettledPillColor(allPill, PILL_REST);

    await expect(page.getByText(followedHorse.display_name).first()).toBeVisible({ timeout: 45_000 });
    await expect(page.locator(".horse-card-web")).toHaveCount(1);
    const otherNames = horseNames.filter((n) => n !== followedHorse.display_name);
    for (const name of otherNames) {
      await expect(page.getByText(name)).toHaveCount(0);
    }
    await page.screenshot({ path: ".rx/review/eng-960-horses-following.png", fullPage: true });

    // --- Trainer roster: all three for-sale horses, and Horses stat = 3. ----
    await page.goto(`/trainers/${trainer.id}`);
    await expect(page.getByRole("heading", { name: "Horses in this stable" })).toBeVisible({ timeout: 45_000 });
    for (const name of horseNames) {
      await expect(page.getByText(name).first()).toBeVisible({ timeout: 45_000 });
    }
    const horsesStat = page.locator(".stat-w").filter({ hasText: "Horses" });
    await expect(horsesStat.locator(".stat-num")).toHaveText("3");
    await page.screenshot({ path: ".rx/review/eng-960-trainer-roster.png", fullPage: true });

    // --- Trainers grid: the seeded trainer's card reads "3 horses". ---------
    await page.goto("/trainers");
    await expect(page.getByRole("heading", { name: "Trainers" })).toBeVisible({ timeout: 45_000 });
    const trainerCard = page.locator(".trainer-card-web").filter({ hasText: "Ruddy Racing ENG960" });
    await expect(trainerCard).toBeVisible({ timeout: 45_000 });
    await expect(trainerCard.locator(".trainer-meta")).toHaveText("3 horses");
    await page.screenshot({ path: ".rx/review/eng-960-trainers-grid.png", fullPage: true });
  } finally {
    // Remove this run's fixtures so a re-run does not accumulate duplicates.
    // NOTE: a PostgREST builder is a THENABLE, not a Promise — it has no
    // `.catch`, so best-effort teardown has to be a try/catch, not `.catch()`.
    try {
      await admin.from("follow").delete().eq("user_id", userId);
      await admin.from("horse").delete().eq("trainer_id", trainer.id);
      await admin.from("trainer").delete().eq("id", trainer.id);
    } catch {
      /* best-effort teardown — never fail the test on cleanup */
    }
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});

test("ENG-960 Following pill shows the true empty state for a member with no follows", async ({ page }) => {
  // A fresh throwaway user who follows nothing at all — the empty state must
  // render for THIS member regardless of what any other seeded fixture (in
  // this file or elsewhere on the shared local database) follows.
  const { email, userId } = await seedMember("eng960-empty");

  try {
    await signIn(page, email);
    await page.goto("/horses");
    await expect(page.getByRole("heading", { name: "Horses" })).toBeVisible({ timeout: 45_000 });

    const followingPill = page.getByRole("button", { name: "Show following" });
    const allPill = page.getByTestId("browse-filter-all");
    await followingPill.click();
    await expect(page.getByTestId("browse-filter-following")).toHaveAttribute("aria-pressed", "true");
    // Wait for the 150ms background transition to actually settle, not just
    // the class flip, so the screenshot shows Following (not All) as the
    // solid brand-green active pill — see the note by BRAND_GREEN above.
    await expectSettledPillColor(followingPill, BRAND_GREEN);
    await expectSettledPillColor(allPill, PILL_REST);

    // The screen's own chrome proves it rendered — asserting only the absence
    // of cards would pass vacuously on a wall or a crash (.rx/gotchas.md).
    await expect(page.locator(".horse-card-web")).toHaveCount(0);
    await expect(page.getByText("You’re not following any horses yet.")).toBeVisible({ timeout: 45_000 });
    await page.screenshot({ path: ".rx/review/eng-960-horses-following-empty.png", fullPage: true });
  } finally {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});
