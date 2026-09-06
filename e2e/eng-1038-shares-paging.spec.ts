// ENG-1038 — /shares "Show more" pager.
//
// Before this ticket `shares-list.tsx` read a bare `.limit(SHARES_PAGE_SIZE)`
// with no pager: row 101 of a stable's for-sale roster was unreachable. This
// spec seeds enough for-sale horses to force a second page, proves the pager
// (`ShowMoreButton`, accessible name "Show more" / "Loading…" / "Try again")
// actually fetches page 2, and proves it retires once there is no more to load.
//
// See .rx/fe-harness.md for the harness convention this mirrors, and
// e2e/eng-956-shares-list.spec.ts for the /shares seeding + selector patterns.
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";

// ONE admin client for the file — see eng-956-shares-list.spec.ts for why a
// module-scope client sidesteps a `ReturnType<typeof createClient>` tsc error.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// "ZZ" keeps every seeded row at the END of the A-Z order (shares-list.tsx
// sorts on the resolved name) so it never disturbs the top of an existing
// roster, and the prefix alone is an exact, unambiguous cleanup tag.
const FIXTURE_PREFIX = "ZZ Pager Fixture";
// 220, not ~120: with the existing ~23 real for-sale horses that lands the
// roster around 243 rows — three pages, not two — so "page 2" (still paging)
// and "pager retired" (out of rows) are genuinely different screens instead of
// the same one-click end state.
const FIXTURE_COUNT = 220;

function fixtureName(n: number): string {
  return `${FIXTURE_PREFIX} ${String(n).padStart(3, "0")}`;
}

async function signIn(page: import("@playwright/test").Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  // `getByLabel("Password")` is ambiguous on this form — the show/hide toggle
  // is `<button aria-label="Show password">`. Target the input by id.
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
}

test("shares 'Show more' pager fetches page 2 and retires on the last page", async ({ page }) => {
  test.setTimeout(120_000);

  // Reuse an existing trainer rather than creating one — trainer_id is a NOT
  // NULL FK on `horse` and the fixture doesn't need its own trainer.
  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .select("id")
    .limit(1)
    .single();
  if (trainerError) throw trainerError;

  const { count: beforeCount } = await admin
    .from("horse")
    .select("id", { count: "exact", head: true });

  // FIXTURE_COUNT for-sale, active rows — enough (with whatever the fixture
  // already holds) to push the roster past the 100-row page size TWICE, so
  // there is a real second page AND a third, short, final one. NOT NULL columns per `\d horse`: trainer_id, status,
  // training_status, display_name.
  const rows = Array.from({ length: FIXTURE_COUNT }, (_, i) => ({
    trainer_id: trainer.id,
    display_name: fixtureName(i + 1),
    status: "active",
    training_status: "racing",
    shares_for_sale: true,
  }));
  const { error: seedError } = await admin.from("horse").insert(rows);
  if (seedError) throw seedError;

  const email = `eng1038-pager-${Date.now()}@stablepass.test`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (userError) throw userError;

  try {
    await signIn(page, email);
    await page.goto("/shares");

    // Cold dev-server route compile can outrun the default 5s budget.
    await expect(page.getByTestId("shares-list")).toBeVisible({ timeout: 45_000 });

    const pager = page.getByRole("button", { name: /Show more|Loading…|Try again/ });
    await expect(pager).toBeVisible();

    // Page-2 row must NOT be present yet — the real proof, not just the shot.
    await expect(page.getByText(fixtureName(101))).toHaveCount(0);

    await pager.scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".rx/review/eng-1038-shares-page1.png", fullPage: true });

    // --- Click 1: fetch page 2.
    const showMore = page.getByRole("button", { name: "Show more" });
    await expect(showMore).toBeVisible();
    await showMore.click();

    // Page-2 row must now be present.
    await expect(page.getByText(fixtureName(101))).toBeVisible();

    // The property this screenshot is actually evidence for: paging CONTINUES
    // past one click rather than being a single one-shot expansion. With 220
    // fixtures + the pre-existing roster there are ~243 rows total, so after
    // exactly one click there is still a third page left to fetch.
    const showMoreAfterClick1 = page.getByRole("button", { name: "Show more" });
    await expect(showMoreAfterClick1).toBeVisible();
    await showMoreAfterClick1.scrollIntoViewIfNeeded();
    await page.screenshot({ path: ".rx/review/eng-1038-shares-page2.png", fullPage: true });

    // --- Keep clicking "Show more" until the pager retires (no more pages).
    // Bounded loop so a stuck pager fails loudly instead of hanging the run.
    for (let i = 0; i < 20; i++) {
      const btn = page.getByRole("button", { name: "Show more" });
      if ((await btn.count()) === 0) break;
      await btn.click();
      await expect(page.getByRole("button", { name: "Loading…" })).toHaveCount(0, { timeout: 15_000 }).catch(() => {});
    }

    // The pager must be gone entirely — the last page is short enough that it
    // has genuinely run out of rows to fetch.
    await expect(page.getByRole("button", { name: /Show more|Loading…|Try again/ })).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.screenshot({ path: ".rx/review/eng-1038-shares-pager-retired.png", fullPage: true });
  } finally {
    // Cleanup is mandatory — a few hundred fake horses left behind would poison
    // every other worker's fixtures. This must run even on failure.
    await admin.from("horse").delete().like("display_name", `${FIXTURE_PREFIX}%`);
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }

    const { count: afterCount } = await admin
      .from("horse")
      .select("id", { count: "exact", head: true });
    console.log(`[eng-1038 cleanup] horse rows before seed: ${beforeCount}, after cleanup: ${afterCount}`);
    expect(afterCount).toBe(beforeCount);
  }
});
