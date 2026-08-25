import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-761 (R20) — member card parity evidence.
//
// WHY THE GALLERY AND NOT /explore: the local `feed` edge function is the
// admin-branch scaffold STUB, which returns `{ data: [], meta }` no matter what
// is published (.rx/gotchas.md). So /explore and /following render their empty
// state locally and any card assertion there would pass vacuously. The shared
// card is evidenced on `/preview/components`, which is no-auth and renders the
// real component with real styles, and the profile screens below are direct
// PostgREST reads that DO render locally.
//
// See .rx/fe-harness.md for the harness convention (per-checkout dev port).
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const SHOTS = ".rx/review";

test("ENG-761 the label pill, caption clamp and photo chip render (component gallery)", async ({ page }) => {
  await page.goto("/preview/components#round6");
  const gallery = page.getByTestId("round6-gallery");
  await expect(gallery).toBeVisible();

  // ITEM 1 — the pill draws post.label, and draws nothing when it is null.
  await expect(gallery.locator(".post-badge")).toHaveCount(3);
  await expect(gallery.locator(".post-badge").nth(0)).toHaveText("Trackwork");
  await expect(gallery.locator(".post-badge").nth(1)).toHaveText("Post Race Report");

  // ITEM 3 — every photo card carries the chip; the video card carries the
  // duration chip instead. Asserted in both directions so "mirrors it" is real.
  await expect(gallery.locator(".media-photo-chip")).toHaveCount(3);
  await expect(gallery.locator(".media-duration")).toHaveCount(1);

  // ITEM 2 — the long caption is CLAMPED, measured rather than eyeballed: a
  // `toBeVisible` would pass either way. The rendered box must be shorter than
  // the text it contains, and about two lines tall.
  const longCaption = gallery.locator("[data-testid=post-caption]").nth(1);
  const box = await longCaption.evaluate((el) => ({
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
  }));
  expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
  expect(box.clientHeight).toBeLessThanOrEqual(Math.round(box.lineHeight * 2) + 2);

  await page.screenshot({ path: `${SHOTS}/eng-761-01-pill-clamp-chip.png`, fullPage: true });

  // The "more" affordance belongs to the clamped card and expands it in place
  // (web has no post-detail route to open).
  // By class, not by name: the card head already has a `⋯` button whose
  // accessible name is "More", so a name-based locator matches one per card.
  const more = gallery.locator(".post-caption-more");
  await expect(more).toHaveCount(1);
  await expect(more).toHaveAccessibleName("Expand caption");
  await more.click();
  await expect(more).toHaveCount(0);
  const expanded = await longCaption.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(expanded).toBeLessThanOrEqual(1);

  await page.screenshot({ path: `${SHOTS}/eng-761-02-caption-expanded.png`, fullPage: true });
});

test("ENG-761 a caption that already fits gets no 'more'", async ({ page }) => {
  await page.goto("/preview/components#round6");
  const gallery = page.getByTestId("round6-gallery");
  await expect(gallery).toBeVisible();

  // The ticket's named edge case. The third fixture is written to fill about two
  // lines without exceeding them, so nothing is hidden and no affordance should
  // be offered. Measured, so this fails if the fixture ever grows a third line.
  const caption = gallery.locator("[data-testid=post-caption]").nth(2);
  const overflow = await caption.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeLessThanOrEqual(1);
  // Exactly one across the whole round-6 gallery: the long card's. This card
  // and the two others hide nothing, so they offer nothing.
  await expect(gallery.locator(".post-caption-more")).toHaveCount(1);
  await expect(caption.locator("~ .post-caption-more")).toHaveCount(0);
});

test("ENG-761 PRIZEMONEY holds one line at 360px and (AUS) is stripped from the name", async ({ page }) => {
  const email = `eng761-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Peter Moody", slug: `peter-moody-${Date.now()}`, stable_name: "Moody Racing", location: "Pakenham, VIC" })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  // The registrar's ALL-CAPS form WITH the suffix the round-6 rule drops. The
  // prize money is seven figures so the label under it is the longest of the
  // four ("PRIZEMONEY"), which is the one that used to wrap.
  const { data: horse, error: horseError } = await admin
    .from("horse")
    .insert({
      trainer_id: trainer.id,
      display_name: "Snitzel x Polar Success",
      racing_name: "CANNONBROOK (AUS)",
      sire: "Snitzel",
      dam: "Polar Success",
      sex: "gelding",
      // A LITERAL year, not `new Date().getFullYear() - n` (ENG-815). Age is
      // derived in Postgres and ENG-617's guard greps the whole repo — e2e
      // included — for date arithmetic, so a seed that computes a foaling year
      // from an age trips it. Nothing here asserts on the rendered age.
      foaling_year: 2021,
      training_status: "racing",
      status: "active",
      starts: 24,
      wins: 6,
      places: 9,
      prize_money_cents: 120_000_000,
    })
    .select("id")
    .single();
  if (horseError) throw horseError;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    // The viewport the ticket names.
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(`/horses/${horse.id}`);

    // ITEM 6 — title-cased, and "(AUS)" gone. The raw column still holds the
    // registrar truth; this is the rendered string only.
    await expect(page.locator(".profile-name-web")).toHaveText("Cannonbrook");

    // ITEM 5 — the stat label must never wrap.
    //
    // HONEST SCOPE OF THIS ASSERTION. The reported "PRIZEMONEY wraps at 360px"
    // does NOT reproduce — not on this branch and not on the merge-base. Both
    // were measured:
    //
    //   innerWidth 360  ->  document.scrollWidth 731
    //   .profile-stats-web 576.8px wide  ->  each stat cell 144px
    //   PRIZEMONEY: 15px tall WITH `nowrap` and 15px tall WITHOUT it
    //
    // `.profile-header-web` (app/globals.css) is `grid-template-columns: 1fr auto`
    // with no mobile breakpoint, so its max-content minimum pushes the whole page
    // to 731px; every stat cell gets 144px rather than the ~90px a true 360px
    // column would give, and the label has room to spare either way. Constraining
    // the grid by hand to 360px does not wrap it either, because the narrow-width
    // rules added for this item (10px, 0.02em) make the string fit a ~90px cell
    // comfortably. In other words the CSS here is DEFENSIVE, and this test is a
    // regression guard, not a reproduction. Do not dress it up as a measured fix.
    //
    // The real defect on this screen is that horizontal overflow. It is larger
    // than this item, it is NOT fixed here, and it is raised separately.
    const label = page.locator(".profile-stats-web .stat-label", { hasText: "Prizemoney" });
    await expect(label).toBeVisible();

    const metrics = await label.evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(cs.lineHeight),
        whiteSpace: cs.whiteSpace,
        // With `nowrap` an over-wide string overflows its box instead of
        // wrapping, so this is what would catch the label outgrowing its cell.
        overflowsCell: el.scrollWidth > el.clientWidth,
      };
    });

    expect(metrics.whiteSpace).toBe("nowrap");
    expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight + 1);
    expect(metrics.overflowsCell).toBe(false);

    // NOT fullPage: fullPage captures `scrollWidth` (731px here, see above),
    // which would silently produce a 731px-wide '360px' screenshot.
    await page.screenshot({ path: `${SHOTS}/eng-761-03-stats-360-aus-stripped.png` });
  } finally {
    // Clean up the CONTENT too, not just the user. These rows are a named
    // trainer and a named horse: left behind they accumulate across runs and
    // drift the /horses and /trainers gallery screenshots (and any count
    // assertion) in other specs. Horse first — `post.horse_id` and the trainer
    // FK order the deletes. Best-effort: never fail the test on teardown.
    await admin.from("horse").delete().eq("id", horse.id).then(undefined, () => {});
    await admin.from("trainer").delete().eq("id", trainer.id).then(undefined, () => {});
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }
  }
});
