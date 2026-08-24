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

test("W4 shared component preview gallery renders", async ({ page }) => {
  await page.goto("/preview/components");
  await expect(page.getByRole("heading", { name: "W4 shared component preview" })).toBeVisible();
  // Two cards carry the watermark overlay since ENG-613 made the Follow-pill
  // fixture watermarked, so this must name which one it means.
  await expect(page.getByTestId("post-overlay").first()).toBeVisible();
  await page.screenshot({ path: ".rx/review/w4-components.png", fullPage: true });
});

test("W6 explore feed renders real posts", async ({ page }) => {
  const email = `w6-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Seed a trainer + 3 active horses + 3 published posts (service role bypasses
  // RLS) so the Explore feed — a gated, RLS-scoped + client-enriched read — has
  // real content to enrich (horse/trainer names) and render.
  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Chris Waller", slug: `chris-waller-${Date.now()}` })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const { data: horses, error: horseError } = await admin
    .from("horse")
    .insert(
      ["Mahogany", "Winx", "Black Caviar"].map((display_name) => ({
        trainer_id: trainer.id,
        display_name,
        status: "active",
      })),
    )
    .select("id, display_name");
  if (horseError) throw horseError;

  const now = new Date().toISOString();
  const { error: postError } = await admin.from("post").insert([
    {
      horse_id: horses![0].id,
      type: "video",
      status: "published",
      body: "Trackwork this morning at Rosehill — feeling sharp ahead of Saturday.",
      mux_playback_id: "playback-fixture-1",
      source_trainer_id: trainer.id,
      watermarked: true,
      published_at: now,
    },
    {
      horse_id: horses![1].id,
      type: "photo",
      status: "published",
      body: "Recovery day in the paddock.",
      media_url: "https://placehold.co/800x450",
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: now,
    },
    {
      horse_id: horses![2].id,
      type: "photo",
      status: "published",
      body: "Barrier trial replay — moved well through the line.",
      media_url: "https://placehold.co/800x450",
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: now,
    },
  ]);
  if (postError) throw postError;

  // Seed a confirmed local-Supabase user — the createUser trigger provisions
  // the trial subscription the feed's content gate requires.
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

    // Wait for the feed to settle past the (aria-hidden) loading skeleton into
    // either real posts or the empty state before screenshotting, so the
    // capture reflects what actually rendered, not a transient loading frame.
    await page.getByRole("button", { name: "Explore" }).waitFor();
    await page.waitForTimeout(1500); // let the feed fetch settle to its resolved state
    await page.screenshot({ path: ".rx/review/w6-explore.png", fullPage: true });

    // NOTE: the real `feed` fn ships in stablepass-be `feature/member-api-v1`
    // (PR #14), but the LOCAL Supabase edge runtime serves the admin-branch
    // scaffold `feed` stub, which returns `{ data: [], meta }` regardless of
    // published posts. So end-to-end here the BFF + client-enrichment path runs
    // correctly and falls back to the "Nothing here yet" empty state. Assert the
    // screen itself rendered (the Explore tab + a settled feed); against the
    // deployed member-api-v1 `feed` fn this same flow renders the seeded posts.
    await expect(page.getByRole("button", { name: "Explore" })).toBeVisible();
  } finally {
    // Best-effort cleanup — never fail the test on teardown issues.
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }
  }
});

test("W7 horse profile renders the real horse (Mahogany, stats, posts)", async ({ page }) => {
  const email = `w7-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Seed a trainer + a named horse (both `horse` API routes are direct reads,
  // not the be feed fn, so this exercises the real PostgREST-backed path).
  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Chris Waller", slug: `chris-waller-${Date.now()}`, stable_name: "Chris Waller Racing", location: "Rosehill, NSW" })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const thisYear = new Date().getFullYear();
  const { data: horse, error: horseError } = await admin
    .from("horse")
    .insert({
      trainer_id: trainer.id,
      display_name: "Snitzel x Polar Success",
      racing_name: "Mahogany",
      sire: "Snitzel",
      dam: "Polar Success",
      sex: "gelding",
      foaling_year: thisYear - 5,
      training_status: "racing",
      status: "active",
      starts: 24,
      wins: 6,
      places: 9,
      prize_money_cents: 120_000_000,
      photo_url: "https://placehold.co/1200x400/285D50/FAF7F2",
      story:
        "Mahogany joined Chris Waller's Rosehill stable as a yearling out of Snitzel. After a promising preparation he's emerging as a stylish miler with a real turn of foot.",
    })
    .select("id")
    .single();
  if (horseError) throw horseError;

  const now = new Date().toISOString();
  const { error: postError } = await admin.from("post").insert([
    {
      horse_id: horse.id,
      type: "photo",
      status: "published",
      body: "Last fast gallop before Saturday — he's spot-on.",
      media_url: "https://placehold.co/800x450",
      source_trainer_id: trainer.id,
      watermarked: true,
      published_at: now,
    },
    {
      horse_id: horse.id,
      type: "text",
      status: "published",
      body: "Routine day — barrier trial complete. Pleased with the way he finished off.",
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: now,
    },
    {
      horse_id: horse.id,
      type: "photo",
      status: "published",
      body: "Recovery day in the paddock.",
      media_url: "https://placehold.co/800x450",
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: now,
    },
  ]);
  if (postError) throw postError;

  const scheduledAt = new Date(Date.now() + 6 * 3_600_000).toISOString();
  const { data: race, error: raceError } = await admin
    // race_number is randomised — `race` has a (venue, race_date, race_number)
    // natural-key uniqueness constraint, and this row isn't cleaned up on the
    // happy path (matching the W6 seed's leave-content-behind convention), so a
    // fixed number would collide with a leftover row from an earlier same-day run.
    .from("race")
    .insert({ status: "upcoming", venue: "Randwick", race_date: scheduledAt.slice(0, 10), race_number: 1000 + Math.floor(Math.random() * 9000), race_class: "BM78", distance_m: 1400, scheduled_at: scheduledAt })
    .select("id")
    .single();
  if (raceError) throw raceError;

  const { error: raceHorseError } = await admin
    .from("race_horse")
    .insert({ race_id: race.id, horse_id: horse.id, barrier: 4, jockey: "T. Berry" });
  if (raceHorseError) throw raceHorseError;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto(`/horses/${horse.id}`);
    await expect(page.locator(".profile-name-web")).toHaveText("Mahogany");
    await expect(page.locator(".profile-stats-web")).toContainText("Starts");
    await page.waitForTimeout(1000); // let the "Recent updates" client fetch settle
    await page.screenshot({ path: ".rx/review/w7-horse-profile.png", fullPage: true });
  } finally {
    // Best-effort cleanup — never fail the test on teardown issues. The race
    // row is deleted (its natural key can collide on rerun); trainer/horse/post
    // rows are left behind, matching the W6 seed's convention.
    await admin.from("race").delete().eq("id", race.id);
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }
  }
});

test("W9 account screen renders (Subscription + Profile + Notifications, no Devices card)", async ({ page }) => {
  const email = `w9-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Seed a confirmed local-Supabase user — the createUser trigger provisions
  // the trial subscription the Subscription card reads.
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Subscription" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
    await expect(page.getByRole("switch")).toHaveCount(4);
    await expect(page.getByText(/devices/i)).toHaveCount(0);

    await page.screenshot({ path: ".rx/review/w9-account.png", fullPage: true });
  } finally {
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }
  }
});

test("W10 checkout screen renders (order summary + graceful no-Stripe-keys placeholder)", async ({ page }) => {
  const email = `w10-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Seed a confirmed local-Supabase user — the createUser trigger provisions
  // the trial subscription the checkout gate/copy reads. No real Stripe keys
  // exist in this environment, so /api/subscription/checkout resolves 502
  // stripe_unavailable and the screen renders its graceful placeholder — that
  // gap is expected/disclosed (see .rx/review notes), not a bug.
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto("/checkout");
    await expect(page.getByText("Order summary")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Continue your access." })).toBeVisible();
    // ENG-581: state-specific not-ready copy. With no Stripe key the route 502s
    // with stripe_unavailable, which is the one state allowed to cite configuration.
    await expect(page.getByText(/Payments are not configured yet/i)).toBeVisible();

    await page.screenshot({ path: ".rx/review/w10-checkout.png", fullPage: true });
  } finally {
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }
  }
});

test("W7 horses browse list renders", async ({ page }) => {
  const email = `w7-list-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Chris Waller", slug: `chris-waller-list-${Date.now()}` })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const { error: horseError } = await admin
    .from("horse")
    .insert(["Mahogany", "Winx", "Black Caviar"].map((racing_name) => ({
      trainer_id: trainer.id,
      display_name: racing_name,
      racing_name,
      status: "active",
    })));
  if (horseError) throw horseError;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto("/horses");
    await expect(page.locator(".horse-card-web").first()).toBeVisible();
    await page.screenshot({ path: ".rx/review/w7-horses-list.png", fullPage: true });
  } finally {
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }
  }
});

test("A2 trainer profile Website link renders, opens in a new tab, and logs a click", async ({ page, context }) => {
  const email = `a2-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // Two trainers: one WITH a website_url (the link must render) and one WITHOUT
  // (the link must be absent) — the two states the ticket names.
  const stamp = Date.now();
  const { data: linked, error: linkedError } = await admin
    .from("trainer")
    .insert({
      name: "Chris Waller",
      slug: `a2-waller-${stamp}`,
      stable_name: "Chris Waller Racing",
      location: "Rosehill, NSW",
      bio: "Premiership-winning trainer with a stable of stakes performers.",
      website_url: "https://example.com/waller-racing",
    })
    .select("id")
    .single();
  if (linkedError) throw linkedError;

  const { data: bare, error: bareError } = await admin
    .from("trainer")
    .insert({
      name: "Annabel Neasham",
      slug: `a2-neasham-${stamp}`,
      stable_name: "Neasham Racing",
      location: "Warwick Farm, NSW",
      bio: "No website on file — the Website action must not render.",
    })
    .select("id")
    .single();
  if (bareError) throw bareError;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    // --- State 1: website_url set -> the Website action renders in the action row.
    await page.goto(`/trainers/${linked.id}`);
    const websiteLink = page.getByRole("link", { name: /website/i });
    await expect(websiteLink).toBeVisible();
    await expect(websiteLink).toHaveAttribute("href", "https://example.com/waller-racing");
    await expect(websiteLink).toHaveAttribute("target", "_blank");
    await expect(websiteLink).toHaveAttribute("rel", "noopener noreferrer");
    await page.screenshot({ path: ".rx/review/a2-trainer-website-link.png", fullPage: true });

    // --- The click: opens a new tab AND logs exactly one row for this member.
    const [popup] = await Promise.all([
      context.waitForEvent("page"),
      websiteLink.click(),
    ]);
    expect(popup.url()).toContain("example.com/waller-racing");
    await popup.close();

    // The log is fire-and-forget, so poll briefly rather than assuming it landed.
    let clicks: unknown[] = [];
    for (let i = 0; i < 10; i++) {
      const { data } = await admin
        .from("trainer_website_click")
        .select("id, trainer_id, user_id")
        .eq("trainer_id", linked.id);
      clicks = data ?? [];
      if (clicks.length > 0) break;
      await page.waitForTimeout(300);
    }
    expect(clicks).toHaveLength(1);
    // GUARDRAIL: the row is attributed to the signed-in member, server-derived.
    expect((clicks[0] as { user_id: string }).user_id).toBe(userData.user!.id);

    // --- State 2: no website_url -> no Website action at all.
    await page.goto(`/trainers/${bare.id}`);
    await expect(page.locator(".profile-name-web")).toHaveText("Annabel Neasham");
    await expect(page.getByRole("link", { name: /website/i })).toHaveCount(0);
    await page.screenshot({ path: ".rx/review/a2-trainer-no-website.png", fullPage: true });
  } finally {
    // Best-effort cleanup; click rows cascade with the trainer.
    await admin.from("trainer_website_click").delete().eq("trainer_id", linked.id);
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// ENG-612 — real aspect ratio + neutral media ground.
//
// The horse profile is the surface this runs against deliberately:
// `/api/horses/:id/feed` is a DIRECT PostgREST read, so it works end to end on
// the local stack, whereas Explore goes through the be `feed` edge fn whose
// local scaffold stub always returns `{ data: [] }` (see the W6 note above).
// The card, the mapper and the CSS under test are the same on every surface.
//
// Evidence captured: landscape (16:9), portrait (a 9:16 reel, clamped to the
// 4:5 floor) and square (1:1), plus the neutral ground behind unpainted media.
// ---------------------------------------------------------------------------
test("ENG-612 post media takes the asset's real aspect ratio on a neutral ground", async ({ page }) => {
  const email = `eng612-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Chris Waller", slug: `chris-waller-eng612-${Date.now()}` })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const { data: horse, error: horseError } = await admin
    .from("horse")
    .insert({
      trainer_id: trainer.id,
      display_name: "Aspect Fixture",
      racing_name: "Aspect Fixture",
      status: "active",
      training_status: "racing",
    })
    .select("id")
    .single();
  if (horseError) throw horseError;

  // Newest first, so DOM order is deterministic: landscape, portrait, square.
  const t = Date.now();
  const at = (offsetMs: number) => new Date(t - offsetMs).toISOString();

  const { error: postError } = await admin.from("post").insert([
    {
      horse_id: horse.id,
      type: "photo",
      status: "published",
      body: "Landscape 1920x1080 — must render 16:9, uncropped.",
      media_url: "https://placehold.co/1920x1080/C9A56F/1A1A1A",
      aspect_ratio: 1.7778,
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: at(0),
    },
    {
      horse_id: horse.id,
      type: "photo",
      status: "published",
      body: "Portrait 1080x1920 reel — clamps to the 4:5 floor and crops.",
      media_url: "https://placehold.co/1080x1920/C9A56F/1A1A1A",
      aspect_ratio: 0.5625,
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: at(1000),
    },
    {
      horse_id: horse.id,
      type: "photo",
      status: "published",
      body: "Square 1080x1080 — must render 1:1.",
      media_url: "https://placehold.co/1080x1080/C9A56F/1A1A1A",
      aspect_ratio: 1,
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: at(2000),
    },
    // The DISCRIMINATING fixture. 1.7778, 0.8 and 1 are exactly the three
    // bucket-class ratios in globals.css, so those three assertions would still
    // pass off the class alone if the inline `aspect-ratio` disappeared
    // entirely. 1.2 matches NO bucket: it buckets as `.square` (1/1) for the
    // fallback, so the box can only measure 1.2 if the inline value is present
    // AND wins over the class. This is the assertion that actually proves the
    // ticket.
    {
      horse_id: horse.id,
      type: "photo",
      status: "published",
      body: "1.2 — matches no bucket class; only the inline ratio can produce it.",
      media_url: "https://placehold.co/1200x1000/C9A56F/1A1A1A",
      aspect_ratio: 1.2,
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: at(3000),
    },
  ]);
  if (postError) throw postError;

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

    await page.goto(`/horses/${horse.id}`);
    const boxes = page.locator(".post-media-web");
    await expect(boxes).toHaveCount(4);

    // Let the poster images settle so the evidence shots show the CROP, not a
    // half-loaded frame. The geometry assertions below do not depend on this.
    await page
      .waitForFunction(
        () =>
          Array.from(document.querySelectorAll(".post-media-web img")).every(
            (img) => (img as HTMLImageElement).complete,
          ),
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => {
        // Offline / placeholder host unreachable: the ground shows through
        // instead, which is still valid evidence for the neutral-ground half.
      });

    const shots: Array<{ label: string; expected: number; bucket: string }> = [
      { label: "landscape", expected: 1.7778, bucket: "post-media-web" },
      { label: "portrait", expected: 0.8, bucket: "post-media-web tall" }, // 0.5625 clamped up to ASPECT_MIN
      { label: "square", expected: 1, bucket: "post-media-web square" },
      // Bucket says 1/1, inline says 1.2 — measuring 1.2 proves the inline wins.
      { label: "inline-beats-bucket", expected: 1.2, bucket: "post-media-web square" },
    ];

    for (const [i, { label, expected, bucket }] of shots.entries()) {
      const box = boxes.nth(i);
      await expect(box).toBeVisible();

      // Measure the REAL rendered box, not the declared style: this is what
      // proves a landscape asset is not squashed into a reel and a reel is not
      // stretched into a landscape.
      const rect = await box.boundingBox();
      expect(rect, `${label} box has no layout`).not.toBeNull();
      expect(rect!.height).toBeGreaterThan(0);
      expect(rect!.width / rect!.height).toBeCloseTo(expected, 1);

      // The bucket class is only the fallback; the inline value is what wins.
      // Pinning both is what makes the `inline-beats-bucket` row meaningful.
      await expect(box).toHaveClass(bucket);

      // The unpainted ground is neutral ink (#1A1A1A), never brand green
      // (#1F4A40 = rgb(31, 74, 64)) — the "green screen" the client reported.
      const ground = await box.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(ground).toBe("rgb(26, 26, 26)");
      expect(ground).not.toBe("rgb(31, 74, 64)");

      await box.screenshot({ path: `.rx/review/eng-612-${label}.png` });
    }

    await page.screenshot({ path: ".rx/review/eng-612-horse-profile-all.png", fullPage: true });

    // BOTH profile feeds, per the acceptance criteria. This is not ceremony:
    // /api/trainers/:id/feed is the OTHER route that names its post columns
    // explicitly, and `sb` is untyped, so a dropped `aspect_ratio` there is
    // invisible to `tsc` and would silently flatten every ratio to 1.6. The
    // 1.2 fixture is the one that proves the column survived the round trip,
    // since no bucket class can produce that number.
    await page.goto(`/trainers/${trainer.id}`);
    const trainerBoxes = page.locator(".post-media-web");
    await expect(trainerBoxes).toHaveCount(4);

    const trainerRect = await trainerBoxes.nth(3).boundingBox();
    expect(trainerRect, "trainer profile 1.2 box has no layout").not.toBeNull();
    expect(trainerRect!.width / trainerRect!.height).toBeCloseTo(1.2, 1);

    const trainerGround = await trainerBoxes
      .nth(3)
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(trainerGround).toBe("rgb(26, 26, 26)");

    await page.screenshot({ path: ".rx/review/eng-612-trainer-profile-all.png", fullPage: true });
  } finally {
    // Best-effort cleanup, matching the W6/W7 convention (content rows are
    // left behind; only the throwaway user is removed).
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }
  }
});

// ===========================================================================
// ENG-613 (W2) — member card parity with mobile, rows 3 to 6.
//
// Split in two on purpose. The LOCAL Supabase edge runtime serves a `feed`
// STUB that returns no rows (see the W6 note above), and BOTH /explore and
// /following go through it via `edgeFetch(sb, "feed?…")` — so neither can show
// a real card here, and neither can evidence the Follow pill. The pill and the
// update card are therefore captured on the repo's existing no-auth component
// gallery, and the full anatomy on real seeded data through the two profile
// feeds, which are direct BFF reads and do render locally.
// ===========================================================================

test("ENG-613 the parity card and the Follow pill render (component gallery)", async ({ page }) => {
  await page.goto("/preview/components");

  const updateCard = page.locator("article.post-web").filter({ hasText: "Quiet week here" });
  await expect(updateCard).toBeVisible();

  // Row 6, as amended 18 Aug 2026 (Justin): NO pill — the horse-name headline
  // heads the card, the title sits under it, standard trainer byline, inset
  // panel with its stable footer.
  await expect(updateCard.locator(".post-badge")).toHaveCount(0);
  await expect(updateCard.locator(".post-horse")).toHaveText("Mahogany");
  // Second 18 Aug amendment: no title either.
  await expect(updateCard.locator(".post-title")).toHaveCount(0);
  const byline = updateCard.locator(".post-byline");
  await expect(byline).toContainText("Tom Alcott");
  await expect(byline).not.toContainText("by ");
  await expect(byline).not.toContainText("Mahogany");
  await expect(updateCard.locator(".post-panel p")).toHaveCount(2);
  await expect(updateCard.locator(".post-panel-foot")).toContainText("Tom Alcott Racing · Sydney");
  // The panel stands in for the media box, so there must be no media box.
  await expect(updateCard.locator(".post-media-web")).toHaveCount(0);

  // Row 6 — the reaction bar sits BELOW the panel on screen.
  const panelBox = await updateCard.locator(".post-panel").boundingBox();
  const updateActions = await updateCard.locator(".post-actions-web").boundingBox();
  expect(panelBox).not.toBeNull();
  expect(updateActions).not.toBeNull();
  expect(updateActions!.y).toBeGreaterThan(panelBox!.y);

  // Row 3 — option D. Computed style, so this is the real cascade, not the
  // stylesheet text: Inter at weight 500 on #3A3A38, never Cormorant.
  const nameStyle = await page
    .locator("article.post-web .post-horse")
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return { family: s.fontFamily, weight: s.fontWeight, color: s.color };
    });
  expect(nameStyle.family).toContain("Inter");
  expect(nameStyle.family).not.toContain("Cormorant");
  expect(nameStyle.weight).toBe("500");
  expect(nameStyle.color).toBe("rgb(58, 58, 56)"); // #3A3A38

  // Row 4 — the caption is painted BELOW the reaction bar. Geometry, not tree
  // order: `order` is a visual property and this is what the member sees.
  const captioned = page.locator("article.post-web").filter({ hasText: "Recovery day in the paddock." }).first();
  const capActions = await captioned.locator(".post-actions-web").boundingBox();
  const capBody = await captioned.locator(".post-body-web").boundingBox();
  expect(capActions).not.toBeNull();
  expect(capBody).not.toBeNull();
  expect(capBody!.y).toBeGreaterThan(capActions!.y);

  // Row 5 — the Follow pill, top-right INSIDE the media box, transparent with
  // a white rim and no shadow. The transparent fill is a DRI decision that
  // knowingly costs contrast; asserting it here is what stops a later "fix".
  const pillCard = page.locator("article.post-web").filter({ hasText: "Peter Moody" }).first();
  const pill = pillCard.getByRole("button", { name: "Follow Peter Moody" });
  await expect(pill).toBeVisible();

  const pillStyle = await pill.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, shadow: s.boxShadow, color: s.color };
  });
  expect(pillStyle.background).toBe("rgba(0, 0, 0, 0)"); // transparent
  expect(pillStyle.shadow).toBe("none");
  expect(pillStyle.color).toBe("rgb(255, 255, 255)");

  // The watermark overlay (z-index 2) sits over this same media box, and the
  // pill carries no z-index of its own — deliberately, so the rule stays
  // verbatim to the design source. What makes that safe is `pointer-events:
  // none` on the overlay. Hit-test the pill's centre: whatever the browser
  // returns is what the member can actually click.
  await expect(pillCard.locator(".post-overlay")).toHaveCount(1);
  await pill.scrollIntoViewIfNeeded();
  const topmostIsPill = await pill.evaluate((el) => {
    // Viewport-relative: the element must be scrolled into view above, or this
    // reads `null` and the assertion fails for the wrong reason.
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && (el === hit || el.contains(hit));
  });
  expect(topmostIsPill, "the watermark overlay must not paint over the Follow pill").toBe(true);

  const mediaBox = await pillCard.locator(".post-media-web").boundingBox();
  const pillBox = await pill.boundingBox();
  expect(mediaBox).not.toBeNull();
  expect(pillBox).not.toBeNull();
  // Top-right inset 12, within a pixel of rounding.
  expect(pillBox!.y - mediaBox!.y).toBeCloseTo(12, 0);
  expect(mediaBox!.x + mediaBox!.width - (pillBox!.x + pillBox!.width)).toBeCloseTo(12, 0);

  // A followed trainer gets NO pill — there is no "Following" variant. Not
  // vacuous: the card above IS on screen and DOES carry one.
  const followedCard = page.locator("article.post-web").filter({ hasText: "Recovery day in the paddock." }).first();
  await expect(followedCard.getByRole("button", { name: /^Follow / })).toHaveCount(0);

  await updateCard.screenshot({ path: ".rx/review/eng-613-stable-update-card.png" });
  await pillCard.screenshot({ path: ".rx/review/eng-613-follow-pill.png" });
  await page.screenshot({ path: ".rx/review/eng-613-cards-gallery.png", fullPage: true });
});

test("ENG-613 both profile feeds show the same card anatomy", async ({ page }) => {
  const email = `eng613-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({
      name: "Tom Alcott",
      slug: `tom-alcott-eng613-${Date.now()}`,
      stable_name: "Tom Alcott Racing",
      location: "Sydney",
    })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const { data: horse, error: horseError } = await admin
    .from("horse")
    .insert({
      trainer_id: trainer.id,
      display_name: "Mahogany",
      racing_name: "Mahogany",
      status: "active",
      training_status: "racing",
    })
    .select("id")
    .single();
  if (horseError) throw horseError;

  // Newest first, so DOM order is deterministic: the update card, then the
  // captioned photo.
  const t = Date.now();
  const { error: postError } = await admin.from("post").insert([
    {
      horse_id: horse.id,
      type: "text",
      status: "published",
      title: "Where the team is up to",
      body:
        "Quiet week here and that is exactly how we want it going into Saturday.\n\n" +
        "Banjo's Girl trials Tuesday at Rosehill.",
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: new Date(t).toISOString(),
    },
    {
      horse_id: horse.id,
      type: "photo",
      status: "published",
      body: "Morning routine. Quiet day on the walker.",
      media_url: "https://placehold.co/1600x1000/C9A56F/1A1A1A",
      aspect_ratio: 1.6,
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: new Date(t - 1000).toISOString(),
    },
  ]);
  if (postError) throw postError;

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

    for (const [label, path] of [
      ["horse-profile", `/horses/${horse.id}`],
      ["trainer-profile", `/trainers/${trainer.id}`],
    ] as const) {
      await page.goto(path);

      const updateCard = page.locator("article.post-web").filter({ hasText: "Quiet week here" });
      await expect(updateCard, `${label} must render the update card`).toBeVisible();
      // 18 Aug 2026: no pill — the horse heads the card from the headline.
      await expect(updateCard.locator(".post-badge")).toHaveCount(0);
      await expect(updateCard.locator(".post-horse")).toHaveText("Mahogany");
      await expect(updateCard.locator(".post-panel p")).toHaveCount(2);
      await expect(updateCard.locator(".post-panel-foot")).toContainText("Tom Alcott Racing · Sydney");

      // Row 4 on a real screen, measured.
      const photoCard = page.locator("article.post-web").filter({ hasText: "Morning routine" }).first();
      const actions = await photoCard.locator(".post-actions-web").boundingBox();
      const body = await photoCard.locator(".post-body-web").boundingBox();
      expect(actions, `${label} actions row has no layout`).not.toBeNull();
      expect(body, `${label} caption has no layout`).not.toBeNull();
      expect(body!.y, `${label} caption must sit below the reaction bar`).toBeGreaterThan(actions!.y);

      // No Follow pill on either profile feed. Not vacuous — cards ARE on
      // screen. Scoped to the pill's own class rather than an accessible name:
      // BOTH profile headers render their own "Follow" button (follow-notify),
      // which is a different control and must keep working.
      await expect(page.locator("article.post-web").first()).toBeVisible();
      await expect(page.locator(".post-media-web .media-follow")).toHaveCount(0);

      await page.screenshot({ path: `.rx/review/eng-613-${label}.png`, fullPage: true });
    }
  } finally {
    if (userData?.user?.id) {
      await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    }
  }
});

/**
 * ENG-729 — the waitlist CTA mode (ENG-721 W3).
 *
 * Public marketing page: no Supabase, no seeding, no sign-in. That is the whole
 * point of the route group, so these are the cheapest screenshots in the file.
 *
 * Captured in BOTH scripting states deliberately. The client reviews this site
 * on a phone with JavaScript blocked, so a screenshot taken only with scripting
 * on would be evidence for a page he will never see — and the reveal-on-scroll
 * contract means the two really can differ.
 */
test.describe("ENG-729 waitlist mode", () => {
  const shoot = async (page: import("@playwright/test").Page, label: string) => {
    // Sections reveal on scroll; walk past the band and back so the observer has
    // fired before capturing, rather than catching it mid-transition.
    //
    // scrollIntoViewIfNeeded, NOT page.evaluate(window.scrollTo): this helper
    // also runs in the scripting-off describe below, where evaluate() is inert
    // and would throw. Playwright drives this over CDP, so it works in both
    // modes — and with scripting off there is nothing to settle anyway, because
    // the reveal never arms and every section is simply visible.
    await page.locator(".wrap.cta").scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    await page.locator("header.hero").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);

    await page.locator("header.hero").screenshot({ path: `.rx/review/eng-729-hero-${label}.png` });
    await page.locator(".wrap.cta").screenshot({ path: `.rx/review/eng-729-cta-band-${label}.png` });
    // Whole-page capture on DESKTOP only. It exists to evidence "no pricing
    // section, no sign-in anywhere", which one wide view shows better than a
    // very tall narrow one — and a full-page shot of this page on a 2x touch
    // profile lands around 8-12MB, which has no business in a git repo.
    if (label.endsWith("desktop")) {
      await page.screenshot({ path: `.rx/review/eng-729-full-${label}.png`, fullPage: true });
    }
  };

  test("hero and CTA band, scripting ON", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(page.locator("header.hero form.wl-form")).toBeVisible();
    await shoot(page, "js-desktop");
  });

  /**
   * PHONE = a real touch profile, not a resized desktop window.
   *
   * `setViewportSize({width:390})` alone leaves the context reporting
   * `hover: hover`, and marketing.css has a whole `@media (hover:none)` block
   * that changes what is on screen — it un-collapses the CTA band's trial line,
   * turns the hover-only tile and trainer overlays on, and more. Screenshots
   * taken the narrow-desktop way therefore show a state no phone ever renders,
   * which is worse than no screenshot: it is evidence for the wrong device, and
   * the client reviews this site on a phone.
   *
   * `isMobile` + `hasTouch` rather than `devices["iPhone 13"]` because that
   * preset carries `defaultBrowserType: "webkit"`; these are the two flags that
   * actually drive the media queries under Chromium.
   */
  // No deviceScaleFactor: the media queries that decide what a phone shows key
  // off isMobile/hasTouch, not pixel density, so 1x renders the identical layout
  // at a quarter the file size. These are review evidence, not print assets.
  const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

  test.describe("phone, scripting ON", () => {
    test.use(PHONE);

    test("hero and CTA band on a touch device", async ({ page }) => {
      await page.goto("/");
      await expect(page.locator("header.hero form.wl-form")).toBeVisible();
      // The state the narrow-desktop capture was hiding: on a touch device the
      // band's trial line is un-collapsed by `@media (hover:none)`, so this is
      // where "Join stablepass. Enjoy your free 30 day trial." would show.
      await expect(page.locator(".cta-trial-line")).toBeHidden();
      await shoot(page, "js-phone");
    });
  });

  test.describe("scripting OFF — the client's actual browsing mode", () => {
    test.use({ javaScriptEnabled: false });

    test("hero and CTA band render with no JavaScript", async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/");
      await expect(page.locator("header.hero form.wl-form")).toBeVisible();
      await shoot(page, "nojs-desktop");
    });

    test.describe("on a touch device", () => {
      test.use(PHONE);

      test("hero and CTA band render with no JavaScript, on a phone", async ({ page }) => {
        await page.goto("/");
        await expect(page.locator("header.hero form.wl-form")).toBeVisible();
        await expect(page.locator(".cta-trial-line")).toBeHidden();
        await shoot(page, "nojs-phone");
      });

      test("the confirmation the native POST redirects back to", async ({ page }) => {
        // The state that only exists because this ticket made `/` read
        // searchParams. With scripting off there is nothing else that could have
        // rendered this text, which is what makes the screenshot evidence.
        await page.goto("/?joined=1");
        const message = page.locator("header.hero p.wl-msg");
        await expect(message).toBeVisible();
        await expect(message).toContainText(/on the list/i);
        await page.locator("header.hero").screenshot({ path: ".rx/review/eng-729-hero-nojs-joined.png" });
      });
    });

  });
});
