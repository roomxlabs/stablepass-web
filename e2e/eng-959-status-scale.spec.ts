// ENG-959 — horse status scale + labels, Shares Available pill, career-stats
// caption removal, "Visit trainer website" wording.
//
// Real end-to-end evidence, not a component render: the horse profile reads the
// `horse` table DIRECTLY through RLS (it does not call its own BFF route), so
// this drives the full stack locally — including the widened
// `HORSE_PROFILE_COLUMNS` projection, which is exactly the thing a unit test
// with a mocked `select()` cannot prove. A column that is not deployed raises
// 42703 and notFound()s the page, so a rendered profile here IS the projection
// check (see `.rx/gotchas.md`).
//
// States captured: a for-sale horse (green pill + primary CTA) and a racing
// horse that is not for sale (neither). Seeded fixture data only; ids are
// discovered at runtime, never hardcoded.
import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// See .rx/fe-harness.md for the full harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const PASSWORD = "harness-password-123!";

// One admin client for the file — see the note in e2e/eng-956-shares-list.spec.ts
// for why this is module scope rather than a threaded parameter.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// The scale, as the browser reports it. These are the mobile hexes (ENG-866 +
// the 1 Sep re-cut) converted to the `rgb()` form `getComputedStyle` returns.
const SCALE = {
  inTraining: "rgb(31, 74, 64)", // var(--brand-green-dark) #1F4A40
  racing: "rgb(92, 64, 51)", //     #5C4033
  sharesGreen: "rgb(40, 93, 80)", // var(--brand-green) #285D50 — the pill only
};

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
  // `getByLabel("Password")` is AMBIGUOUS on this form (the show/hide toggle is
  // an `aria-label`ed button Playwright also resolves) — target the input by id.
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
}

/** A trainer with a public website + one horse, both discovered at runtime. */
async function seedHorse(opts: {
  stamp: number;
  displayName: string;
  trainingStatus: string;
  sharesForSale: boolean;
  websiteUrl: string | null;
}) {
  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({
      name: "Chris Waller",
      slug: `eng959-waller-${opts.stamp}`,
      stable_name: "Waller Racing",
      location: "Rosehill",
      website_url: opts.websiteUrl,
    })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const { data: horse, error: horseError } = await admin
    .from("horse")
    .insert({
      trainer_id: trainer.id,
      display_name: opts.displayName,
      status: "active",
      training_status: opts.trainingStatus,
      shares_for_sale: opts.sharesForSale,
      starts: 12,
      wins: 4,
      places: 3,
      prize_money_cents: 4_500_000,
    })
    .select("id")
    .single();
  if (horseError) throw horseError;

  return { trainerId: trainer.id as string, horseId: horse.id as string };
}

test('for-sale horse: "In training" dark green, green Shares Available pill, primary website CTA', async ({
  page,
}) => {
  const stamp = Date.now();
  const { email, userId } = await seedMember("eng959-sale");
  // `in_training`, NOT the legacy `farm_training` this spec first tried: the
  // 1 Sep 2026 migration has already landed locally and `horse_training_status_check`
  // now admits only the six canonical values, so seeding a legacy spelling fails
  // with 23514 before the page is ever reached. The legacy collapse
  // (farm/city -> "In training") is therefore proved at unit level in
  // test/horse-status-scale.test.tsx, where the value can exist; the production
  // switch keeps those cases for clients rendering a cached pre-migration row.
  const { horseId } = await seedHorse({
    stamp,
    displayName: "Mahogany",
    trainingStatus: "in_training",
    sharesForSale: true,
    websiteUrl: "https://wallerracing.example",
  });

  try {
    await signIn(page, email);
    await page.goto(`/horses/${horseId}`);

    // The screen's own chrome proves it RENDERED — asserting only the presence
    // of a pill would pass vacuously on a wall or a crash (.rx/gotchas.md).
    await expect(page.getByRole("heading", { name: "Mahogany", exact: true })).toBeVisible({ timeout: 45_000 });

    // The label port: "In training", not the old underscore-strip's "In training"
    // by luck — and on the dark-green ground the scale assigns it.
    const status = page.locator(".status-row .tag").first();
    await expect(status).toHaveText("In training");
    await expect(status).toHaveClass(/status-in-training/);
    await expect(status).toHaveCSS("background-color", SCALE.inTraining);

    // The pill is NOT a training status and keeps the plain brand green, which
    // is why "In training" above had to be one step darker.
    const pill = page.locator(".status-row .tag.race-day");
    await expect(pill).toHaveText("Shares Available");
    await expect(pill).toHaveCSS("background-color", SCALE.sharesGreen);

    // The CTA — the one agreed wording, drawn as the green primary here.
    const cta = page.locator(".profile-shares-cta-web a");
    await expect(cta).toHaveText(/Visit trainer website/);
    await expect(cta).toHaveClass(/btn-primary/);
    await expect(cta).toHaveAttribute("href", "https://wallerracing.example");

    // The removed caption (ENG-929) — gone from the live screen, not merely
    // from the source.
    await expect(page.locator(".stats-note-web")).toHaveCount(0);
    await expect(page.getByText("Career stats")).toHaveCount(0);

    await page.screenshot({ path: ".rx/review/eng-959-horse-for-sale.png", fullPage: true });
  } finally {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});

test("racing horse, not for sale: dark brown Racing tag, no pill, no CTA", async ({ page }) => {
  const stamp = Date.now() + 1;
  const { email, userId } = await seedMember("eng959-racing");
  const { horseId } = await seedHorse({
    stamp,
    displayName: "Winx",
    trainingStatus: "racing",
    sharesForSale: false,
    websiteUrl: "https://wallerracing.example",
  });

  try {
    await signIn(page, email);
    await page.goto(`/horses/${horseId}`);
    await expect(page.getByRole("heading", { name: "Winx", exact: true })).toBeVisible({ timeout: 45_000 });

    // Racing keeps ENG-866's saddle brown — and loses the "●" bullet the old
    // inline special case drew, which existed nowhere else in the product.
    const status = page.locator(".status-row .tag").first();
    await expect(status).toHaveText("Racing");
    await expect(status).toHaveCSS("background-color", SCALE.racing);

    // Not for sale: no pill and no CTA, even though this trainer HAS a website.
    // That is the gate — the CTA is `shares_for_sale AND website`, never either.
    await expect(page.locator(".status-row .tag.race-day")).toHaveCount(0);
    await expect(page.getByText("Shares Available")).toHaveCount(0);
    await expect(page.locator(".profile-shares-cta-web")).toHaveCount(0);
    await expect(page.getByText("Visit trainer website")).toHaveCount(0);

    await page.screenshot({ path: ".rx/review/eng-959-horse-racing.png", fullPage: true });
  } finally {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});
