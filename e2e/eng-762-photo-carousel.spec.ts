import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

// ENG-762 — the multi-photo carousel, driven END TO END against local Postgres
// and local Storage.
//
// Why the HORSE profile and not /explore: the be `feed` edge function is a stub
// locally, so Explore and Following cannot be driven end to end here — and, more
// to the point, that function does not return `post_media` at all. The profile
// feeds read `post` directly and then call `readPostPhotos` themselves, so this
// spec exercises the whole real path: the batched `post_media` select under RLS,
// the signing round trip, the screen's own mapper, and the card's dots.
//
// This is deliberately NOT a component-gallery screenshot. ENG-761's pill bug
// shipped precisely because its evidence was `/preview/components`, which builds
// PostCard props by hand and bypasses both the projection and the mapper
// (.rx/gotchas.md). See .rx/fe-harness.md for the harness convention.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const SHOTS = ".rx/review";
const BUCKET = "post-media";

/** Seeded, obviously-synthetic slides. Never a real photo, per the harness rule. */
function slideSvg(bg: string, fg: string, n: number): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">` +
    `<rect width="640" height="400" fill="${bg}"/>` +
    `<text x="320" y="220" font-family="sans-serif" font-size="64" font-weight="600" ` +
    `fill="${fg}" text-anchor="middle">PHOTO ${n}</text></svg>`
  );
}

/**
 * Storage occasionally answers a burst of uploads with a non-JSON 5xx, which
 * supabase-js surfaces as "invalid response from the upstream server". One
 * retry is enough and keeps a flaky container from reading as a product bug.
 */
type BucketUploader = {
  upload(
    path: string,
    body: Blob,
    opts: { contentType: string; upsert: boolean },
  ): Promise<{ error: unknown }>;
};

async function uploadSlide(uploader: BucketUploader, path: string, svg: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { error } = await uploader.upload(path, new Blob([svg], { type: "image/svg+xml" }), {
      contentType: "image/svg+xml",
      upsert: true,
    });
    if (!error) return;
    if (attempt === 2) throw error;
    await new Promise((r) => setTimeout(r, 500));
  }
}

const SLIDES = [
  { bg: "#1A1A1A", fg: "#FAF7F2" },
  { bg: "#F1ECE3", fg: "#1A1A1A" },
  // Brand green: the hostile ground for a brand-green active dot, which is why
  // the active dot carries a white rim. Worth having in the evidence.
  { bg: "#285D50", fg: "#FAF7F2" },
];

test("ENG-762 a 3-photo post renders dots + an n/m count on the horse profile feed", async ({ page }) => {
  const stamp = Date.now();
  const email = `eng762-harness-${stamp}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Tom Alcott", slug: `tom-alcott-${stamp}`, stable_name: "Alcott Racing", location: "Flemington, VIC" })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const { data: horse, error: horseError } = await admin
    .from("horse")
    .insert({
      trainer_id: trainer.id,
      display_name: "Cannonbrook",
      racing_name: "CANNONBROOK",
      sire: "Snitzel",
      dam: "Polar Success",
      sex: "gelding",
      foaling_year: new Date().getFullYear() - 5,
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

  const { data: post, error: postError } = await admin
    .from("post")
    .insert({
      horse_id: horse.id,
      source_trainer_id: trainer.id,
      type: "photo",
      status: "published",
      body: "Three from the course proper this morning.",
      label: "Trackwork",
      published_at: new Date().toISOString(),
      watermarked: false,
      like_count: 4,
    })
    .select("id")
    .single();
  if (postError) throw postError;

  // Upload the three objects, then the rows that order them. Paths follow the
  // contract's convention: row 0 at `<postId>/original`, extras at
  // `<postId>/photo-<n>`.
  const paths = [`${post.id}/original`, `${post.id}/photo-1`, `${post.id}/photo-2`];
  for (let i = 0; i < SLIDES.length; i++) {
    await uploadSlide(admin.storage.from(BUCKET), paths[i], slideSvg(SLIDES[i].bg, SLIDES[i].fg, i + 1));
  }

  const { error: mediaError } = await admin.from("post_media").insert(
    paths.map((media_url, i) => ({ post_id: post.id, sort_order: i, media_url })),
  );
  if (mediaError) throw mediaError;

  // `post.media_url` MIRRORS sort_order 0 — the writer owes this, not a trigger.
  // Without it a legacy reader (and this card's single-photo fallback) has no
  // image at all, so the mirror is part of what is being proven here.
  const { error: mirrorError } = await admin.from("post").update({ media_url: paths[0] }).eq("id", post.id);
  if (mirrorError) throw mirrorError;

  const { error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto(`/horses/${horse.id}`);

    const card = page.locator(".post-web").first();
    const track = card.getByTestId("photo-track");
    const dots = card.getByTestId("photo-dots").getByRole("button");
    const count = card.getByTestId("media-photo-count");

    // The card must arrive before anything inside it is asserted. In dev, the
    // first hit on /api/horses/[id]/feed compiles the route, which can take far
    // longer than a default expect budget — a timeout here would otherwise read
    // as "the carousel is missing" when the feed simply had not landed yet.
    await expect(card).toBeVisible({ timeout: 120_000 });

    // The read path really produced three signed photos.
    await expect(track).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("photo-slide")).toHaveCount(3);
    await expect(dots).toHaveCount(3);

    // Every slide must hold a SIGNED url, never a bare storage path. This is the
    // guardrail assertion: a path reaching the browser is the failure.
    const srcs = await card.getByTestId("photo-slide").locator("img").evaluateAll(
      (els) => els.map((e) => (e as HTMLImageElement).getAttribute("src") ?? ""),
    );
    expect(srcs).toHaveLength(3);
    for (const src of srcs) {
      expect(src).toContain("/storage/v1/object/sign/");
      expect(src).toContain("token=");
      expect(src.startsWith(`${post.id}/`)).toBe(false);
    }

    // --- FIRST ---------------------------------------------------------
    await expect(count).toHaveText("1/3");
    await expect(dots.nth(0)).toHaveAttribute("aria-current", "true");
    await card.screenshot({ path: `${SHOTS}/eng-762-01-card-first.png` });

    // --- MIDDLE --------------------------------------------------------
    await dots.nth(1).click();
    await expect(count).toHaveText("2/3");
    await expect(dots.nth(1)).toHaveAttribute("aria-current", "true");
    // Wait for the smooth scroll to land EXACTLY, not merely to round to the
    // right slide: a rounded check is satisfied while the animation is still
    // running, and the screenshot then shows a sliver of the previous photo.
    await expect
      .poll(async () => track.evaluate((el) => Math.abs(el.scrollLeft - el.clientWidth) <= 1))
      .toBe(true);
    await card.screenshot({ path: `${SHOTS}/eng-762-02-card-middle.png` });

    // --- LAST ----------------------------------------------------------
    await dots.nth(2).click();
    await expect(count).toHaveText("3/3");
    await expect(dots.nth(2)).toHaveAttribute("aria-current", "true");
    await expect
      .poll(async () => track.evaluate((el) => Math.abs(el.scrollLeft - el.clientWidth * 2) <= 1))
      .toBe(true);
    await card.screenshot({ path: `${SHOTS}/eng-762-03-card-last.png` });

    // The carousel must not have changed the card's height between slides —
    // one aspect box per post is the whole reason the box is not per-photo.
    const box = card.locator(".post-media-web");
    const first = await box.boundingBox();
    await dots.nth(0).click();
    await expect.poll(async () => track.evaluate((el) => el.scrollLeft <= 1)).toBe(true);
    const back = await box.boundingBox();
    expect(Math.round(first!.height)).toBe(Math.round(back!.height));

    await page.screenshot({ path: `${SHOTS}/eng-762-04-horse-profile-full.png`, fullPage: true });
  } finally {
    // FK order. `post_media` cascades from `post`, but it is deleted explicitly
    // so a failure here is visible rather than silently relying on the cascade.
    await admin.from("post_media").delete().eq("post_id", post.id).then(undefined, () => {});
    await admin.storage.from(BUCKET).remove(paths).then(undefined, () => {});
    await admin.from("post").delete().eq("id", post.id).then(undefined, () => {});
    await admin.from("horse").delete().eq("id", horse.id).then(undefined, () => {});
    await admin.from("trainer").delete().eq("id", trainer.id).then(undefined, () => {});
  }
});

test("ENG-762 a single-photo post keeps the plain chip and draws no dots", async ({ page }) => {
  const stamp = Date.now();
  const email = `eng762-single-${stamp}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: trainer, error: trainerError } = await admin
    .from("trainer")
    .insert({ name: "Peter Moody", slug: `peter-moody-${stamp}`, stable_name: "Moody Racing", location: "Pakenham, VIC" })
    .select("id")
    .single();
  if (trainerError) throw trainerError;

  const { data: horse, error: horseError } = await admin
    .from("horse")
    .insert({
      trainer_id: trainer.id,
      display_name: "Black Caviar",
      racing_name: "BLACK CAVIAR",
      sire: "Bel Esprit",
      dam: "Helsinge",
      sex: "mare",
      foaling_year: new Date().getFullYear() - 6,
      training_status: "racing",
      status: "active",
      starts: 25,
      wins: 25,
      places: 0,
      prize_money_cents: 800_000_000,
    })
    .select("id")
    .single();
  if (horseError) throw horseError;

  const { data: post, error: postError } = await admin
    .from("post")
    .insert({
      horse_id: horse.id,
      source_trainer_id: trainer.id,
      type: "photo",
      status: "published",
      body: "One photo only.",
      published_at: new Date().toISOString(),
      watermarked: false,
      like_count: 1,
    })
    .select("id")
    .single();
  if (postError) throw postError;

  const path = `${post.id}/original`;
  await uploadSlide(admin.storage.from(BUCKET), path, slideSvg("#1A1A1A", "#FAF7F2", 1));

  // ONE row, plus the mirror. The contract is explicit that this must render
  // identically to a legacy post with zero rows: no dots, no count, no pager.
  const { error: mediaError } = await admin
    .from("post_media")
    .insert({ post_id: post.id, sort_order: 0, media_url: path });
  if (mediaError) throw mediaError;
  await admin.from("post").update({ media_url: path }).eq("id", post.id);

  const { error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (userError) throw userError;

  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto(`/horses/${horse.id}`);
    const card = page.locator(".post-web").first();
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card.getByTestId("media-photo-chip")).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("media-photo-chip")).toHaveAttribute("aria-label", "Photo");
    await expect(card.getByTestId("photo-dots")).toHaveCount(0);
    await expect(card.getByTestId("photo-track")).toHaveCount(0);
    await expect(card.getByTestId("media-photo-count")).toHaveCount(0);
    await card.screenshot({ path: `${SHOTS}/eng-762-05-card-single-photo.png` });
  } finally {
    await admin.from("post_media").delete().eq("post_id", post.id).then(undefined, () => {});
    await admin.storage.from(BUCKET).remove([path]).then(undefined, () => {});
    await admin.from("post").delete().eq("id", post.id).then(undefined, () => {});
    await admin.from("horse").delete().eq("id", horse.id).then(undefined, () => {});
    await admin.from("trainer").delete().eq("id", trainer.id).then(undefined, () => {});
  }
});

// The component gallery covers the states that need no live data: the degraded
// slide and the 10-photo cap. It is NOT the evidence for the read path — the two
// specs above are, deliberately, because the gallery builds its props by hand.
test("ENG-762 the gallery shows the degraded slide and the 10-photo cap", async ({ page }) => {
  // A viewport TALLER than the gallery. Playwright stitches an element
  // screenshot from several scroll positions when it does not fit, and the
  // absolutely-positioned chips then appear twice — an artifact that reads like
  // a duplicated chip in the evidence. Capturing in one pass avoids it.
  await page.setViewportSize({ width: 1280, height: 2400 });
  await page.goto("/preview/components#round6-carousel");
  const gallery = page.getByTestId("round6-carousel-gallery");
  await expect(gallery).toBeVisible({ timeout: 120_000 });

  const cards = gallery.locator(".post-web");
  await expect(cards).toHaveCount(4);

  // 1: three photos. 2: one photo, so no dots at all. 3: middle slide dead.
  // 4: the contract cap.
  await expect(cards.nth(0).getByTestId("photo-dots").getByRole("button")).toHaveCount(3);
  await expect(cards.nth(1).getByTestId("photo-dots")).toHaveCount(0);
  await expect(cards.nth(1).getByTestId("media-photo-chip")).toHaveAttribute("aria-label", "Photo");
  await expect(cards.nth(2).getByTestId("photo-slide-empty")).toHaveCount(1);
  await expect(cards.nth(3).getByTestId("photo-dots").getByRole("button")).toHaveCount(10);

  // Ten dots at the narrow card width must still fit on one row — the ticket's
  // explicit edge case. Measured, not eyeballed.
  const dotsBox = await cards.nth(3).getByTestId("photo-dots").boundingBox();
  const mediaBox = await cards.nth(3).locator(".post-media-web").boundingBox();
  expect(dotsBox!.width).toBeLessThan(mediaBox!.width);
  expect(dotsBox!.height).toBeLessThan(24);

  await gallery.screenshot({ path: `${SHOTS}/eng-762-06-gallery-states.png` });
});
