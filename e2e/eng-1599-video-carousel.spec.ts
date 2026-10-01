import { test, expect, type Page, type Request } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { passwordField } from "./helpers/sign-in";

/**
 * ENG-1599 (MV-W1) — the video carousel, driven as a real ENTITLED member in
 * Firefox against local Postgres + Storage + the be's edge functions.
 *
 * WHAT IS REAL HERE. The post, its three `post_video` rows (ENG-1594/1596), the
 * posters in the private `post-media` bucket, the member and their
 * subscription, the BFF, and the be's `post-media` batch (`videoCount`) and
 * `playback?posterOnly=1&videoIndex=i` mint — so the dots are drawn from the
 * live `videoCount` and every slide poster is a genuinely minted, re-gated URL.
 * Serve them with `npx supabase functions serve` from a be checkout on
 * `feature/release-v1`; without it the batch 503s and the card renders single.
 *
 * WHAT IS STUBBED, AND WHY. The STREAM half of the playback mint only. A local
 * stack holds no Mux signing key, so `GET /api/posts/:id/playback[?videoIndex=i]`
 * (never the posterOnly one) is answered by the test. The requests are recorded,
 * which is the property under test: the client names an ordinal, never an id.
 *
 * TWO STAND-INS FOR THE STREAM, because Playwright's Firefox has NO H.264
 * decoder (`MediaSource.isTypeSupported('video/mp4; codecs="avc1…"')` is false)
 * and every Mux rendition is H.264:
 *   - the TRANSPORT test answers with a public Mux test HLS manifest and proves
 *     hls.js fetches exactly the minted url for `videoIndex=1` (it then fails
 *     to decode, and the card shows the honest pill — asserted, not hidden);
 *   - the FLOW test answers with a 2-second VP8 WebM fixture Firefox plays
 *     natively, so a video genuinely plays, ENDS and auto-advances.
 * Real Chrome/Safari playback of a real signed Mux stream stays a manual check.
 *
 * FIREFOX, deliberately (.rx/gotchas.md): its `canPlayType(HLS)` is `""`, so
 * the transport test exercises the hls.js path a member's desktop browser takes.
 */
test.use({ browserName: "firefox" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** A public Mux test stream (HLS, H.264) — the transport test's stand-in. */
const TEST_STREAM = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
/** The flow test's stand-in: a 2 s VP8 clip, served per index from this origin. */
const CLIP_ORIGIN = "https://media.stablepass.test";
const CLIP = readFileSync(join(__dirname, "fixtures", "eng-1599-clip.webm"));
const PASSWORD = "harness-password-123!";
const SHOTS = ".rx/review";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

/** A 16:10 poster with a big numeral, so a screenshot shows WHICH video is on screen. */
async function posterJpeg(label: string, bg: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">
    <rect width="800" height="500" fill="${bg}"/>
    <text x="400" y="290" font-family="sans-serif" font-size="120" font-weight="700"
      fill="#FAF7F2" text-anchor="middle">${label}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

async function upload(path: string, bytes: Buffer) {
  const { error } = await admin.storage.from("post-media").upload(path, bytes, { contentType: "image/jpeg", upsert: true });
  if (error) throw error;
}

type Seed = { horseId: string; carouselId: string; singleId: string };

async function seed(tag: string): Promise<Seed> {
  const { data: trainer, error: tErr } = await admin
    .from("trainer")
    .insert({ name: "Chris Waller", slug: `eng1599-waller-${tag}` })
    .select("id")
    .single();
  if (tErr) throw tErr;
  const { data: horse, error: hErr } = await admin
    .from("horse")
    .insert({ trainer_id: trainer.id, display_name: "Mahogany", racing_name: "Mahogany", status: "active" })
    .select("id")
    .single();
  if (hErr) throw hErr;

  const insertVideoPost = async (body: string, publishedAt: string) => {
    const { data, error } = await admin
      .from("post")
      .insert({
        horse_id: horse.id,
        type: "video",
        status: "published",
        body,
        media_url: null,
        mux_playback_id: `pb-eng1599-${tag}-${body.length}`,
        source_trainer_id: trainer.id,
        watermarked: false,
        published_at: publishedAt,
      })
      .select("id")
      .single();
    if (error) throw error;
    return data.id as string;
  };

  // The carousel post is the NEWEST, so it is the first card on the profile.
  const singleId = await insertVideoPost("One gallop, one video.", new Date(Date.now() - 60_000).toISOString());
  const carouselId = await insertVideoPost("Three angles from this morning's gallop.", new Date().toISOString());

  await upload(`posters/${singleId}.jpg`, await posterJpeg("single", "#1A1A1A"));
  const { error: sErr } = await admin.from("post").update({ poster_url: `posters/${singleId}.jpg` }).eq("id", singleId);
  if (sErr) throw sErr;

  const colours = ["#285D50", "#7A4E2D", "#2D3F7A"];
  for (let i = 0; i < 3; i++) {
    const path = `posters/${carouselId}-v${i}.jpg`;
    await upload(path, await posterJpeg(`video ${i + 1}`, colours[i]));
    const { error } = await admin.from("post_video").insert({
      post_id: carouselId,
      sort_order: i,
      status: "ready",
      mux_playback_id: `pb-eng1599-${tag}-v${i}`,
      poster_url: path,
    });
    if (error) throw error;
  }
  return { horseId: horse.id, carouselId, singleId };
}

async function member(tag: string, status: "active" | "lapsed"): Promise<string> {
  const email = `eng1599-${status}-${tag}@stablepass.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const { error: subErr } = await admin
    .from("subscription")
    .update(
      status === "active"
        ? { status: "active", current_period_end: "2099-01-01T00:00:00Z" }
        : { status: "lapsed", current_period_end: "2020-01-01T00:00:00Z" },
    )
    .eq("user_id", data.user.id);
  if (subErr) throw subErr;
  return email;
}

async function signIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await passwordField(page).fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(/\/(explore|account|checkout|start)/);
}

/**
 * Edge functions served LOCALLY (`supabase functions serve`) sign Storage urls
 * against the container-internal `SUPABASE_URL` — `http://kong:8000/…` — which
 * the browser cannot resolve, so every minted poster would be a broken image.
 * Production signs against the public host. Rewrite the host, nothing else: the
 * signed path and token are served by the real Storage.
 */
async function reachLocalStorage(page: Page) {
  await page.route("http://kong:8000/**", async (route) => {
    const url = route.request().url().replace("http://kong:8000", SUPABASE_URL);
    await route.fulfill({ response: await route.fetch({ url }) });
  });
}

/** Every playback request the page makes, split into poster and stream mints. */
function recordMints(page: Page) {
  const posters: string[] = [];
  const streams: string[] = [];
  page.on("request", (req: Request) => {
    const url = new URL(req.url());
    if (!/^\/api\/posts\/[^/]+\/playback$/.test(url.pathname)) return;
    (url.searchParams.get("posterOnly") === "1" ? posters : streams).push(url.pathname + url.search);
  });
  return { posters, streams };
}

/**
 * Stub ONLY the stream mint (no Mux signing key locally); posters go to the real
 * be. `clip` answers every mint with the WebM fixture at a per-index url; `hls`
 * answers with the Mux test manifest.
 */
async function stubStreamMint(page: Page, kind: "clip" | "hls") {
  await page.route("**/api/posts/*/playback**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("posterOnly") === "1") return route.continue();
    const playbackUrl =
      kind === "hls" ? TEST_STREAM : `${CLIP_ORIGIN}/clip-${url.searchParams.get("videoIndex") ?? "0"}.webm`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { playbackUrl, posterUrl: null, expiresAt: "2099-01-01T00:00:00Z" } }),
    });
  });
  if (kind === "clip") {
    await page.route(`${CLIP_ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "video/webm", body: CLIP }),
    );
  }
}

test("an entitled member pages, plays, auto-advances and gets one player at a time", async ({ page }) => {
  test.setTimeout(120_000);
  const tag = String(Date.now());
  const s = await seed(tag);
  const email = await member(tag, "active");
  const mints = recordMints(page);
  await reachLocalStorage(page);
  await stubStreamMint(page, "clip");

  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, email);
  await page.goto(`/horses/${s.horseId}`);

  const card = page.locator(".post-web").filter({ has: page.getByTestId("video-track") }).first();
  await expect(card).toBeVisible();
  const media = card.locator(".post-media-web");

  // Dots and "1/3" from the LIVE batch videoCount.
  await expect(media.getByRole("button", { name: /^Go to video \d of 3$/ })).toHaveCount(3);
  await expect(media.getByRole("img", { name: "Video 1 of 3" })).toHaveText("1/3");
  // The card's single play button stood down; each slide has its own.
  await expect(media.getByRole("button", { name: "Play video", exact: true })).toHaveCount(0);

  // Lazy posters: the active slide's neighbour (index 1) only — slide 0's came
  // with the page, and index 2 is not asked for until the member moves. Compared
  // as a SET: `next dev` runs React in StrictMode, which loads this screen's
  // list twice and so mounts the card twice (index 0's page poster is fetched
  // twice too); a production build mints each index once.
  const slidePosters = () =>
    [...new Set(mints.posters.filter((u) => u.includes(s.carouselId) && u.includes("videoIndex")))];
  await expect.poll(slidePosters).toEqual([`/api/posts/${s.carouselId}/playback?posterOnly=1&videoIndex=1`]);
  // Both posters are real, minted, decoded images (slide 0's from the page).
  for (const i of [0, 1]) {
    const img = media.locator(`[data-video-index="${i}"] img`);
    await expect(img).toHaveCount(1);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  }
  // No autoplay on load. Since ENG-1633 the feed PRE-MINTS the on-screen
  // cards' stream urls into memory (so `mints.streams` is no longer empty), but
  // nothing is PLAYED until a tap: no <video> element exists anywhere yet, and
  // no slide past the one on screen has been asked for.
  expect(mints.streams.filter((u) => /videoIndex=[12]/.test(u))).toEqual([]);
  await expect(page.locator("video")).toHaveCount(0);
  await expect(media.locator("video")).toHaveCount(0);

  await card.scrollIntoViewIfNeeded();
  await media.hover();
  await card.screenshot({ path: `${SHOTS}/eng-1599-01-carousel-1280.png` });

  // Arrow → slide 2 (and its neighbour's poster is minted now, never before).
  await media.getByRole("button", { name: "Next video" }).click();
  await expect(media.getByRole("img", { name: "Video 2 of 3" })).toHaveText("2/3");
  await expect.poll(() => mints.posters.some((u) => u.endsWith(`${s.carouselId}/playback?posterOnly=1&videoIndex=2`))).toBe(true);
  // Let the smooth scroll land on slide 2 before the evidence is captured.
  await expect
    .poll(() => card.getByTestId("video-track").evaluate((el) => Math.abs(el.scrollLeft - el.clientWidth)))
    .toBeLessThan(2);
  await media.hover();
  await card.screenshot({ path: `${SHOTS}/eng-1599-02-slide2-arrows-1280.png` });

  // Tap to play slide 2 → mints videoIndex=1, streams through hls.js.
  await media.getByRole("button", { name: "Play video 2 of 3" }).click();
  await expect.poll(() => mints.streams).toContain(`/api/posts/${s.carouselId}/playback?videoIndex=1`);
  const video2 = media.locator('[data-video-index="1"] video');
  await expect(video2).toHaveCount(1);
  await expect.poll(() => video2.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 }).toBeGreaterThan(0);
  await card.screenshot({ path: `${SHOTS}/eng-1599-03-playing-1280.png` });

  // Auto-advance: the 2 s clip ENDS on its own → slide 3, which is minted and
  // started (or, if Firefox declines an unattended play, shows its play button).
  await expect(media.getByRole("button", { name: "Go to video 3 of 3" })).toHaveAttribute("aria-current", "true", { timeout: 20_000 });
  await expect.poll(() => mints.streams).toContain(`/api/posts/${s.carouselId}/playback?videoIndex=2`);
  const video3 = media.locator('[data-video-index="2"] video');
  await expect(video3).toHaveCount(1);
  await expect(video2).toHaveCount(0); // the ended slide's player is gone
  const blocked = media.locator('[data-video-index="2"]').getByRole("button", { name: "Play video 3 of 3" });
  if (await blocked.isVisible()) await blocked.click();
  await expect.poll(() => video3.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t load" })).toHaveCount(0); // no error UI on the way

  // The LAST slide stops: its clip ends and nothing further is minted.
  const streamsBefore = mints.streams.length;
  await expect.poll(() => video3.evaluate((v: HTMLVideoElement) => v.ended), { timeout: 20_000 }).toBe(true);
  expect(mints.streams.length).toBe(streamsBefore);
  await expect(media.getByRole("button", { name: "Go to video 3 of 3" })).toHaveAttribute("aria-current", "true");

  // One player feed-wide: starting the single-video post's video stops the carousel's.
  await media.getByRole("button", { name: "Go to video 1 of 3" }).click();
  await media.getByRole("button", { name: "Play video 1 of 3" }).click();
  await expect.poll(() => mints.streams).toContain(`/api/posts/${s.carouselId}/playback`);
  await expect(media.locator('[data-video-index="0"] video')).toHaveCount(1);
  const single = page.locator(".post-web").filter({ hasText: "One gallop, one video." }).first();
  await single.getByRole("button", { name: "Play video", exact: true }).click();
  await expect.poll(() => mints.streams).toContain(`/api/posts/${s.singleId}/playback`);
  await expect(single.locator("video")).toHaveCount(1);
  await expect(media.locator("video")).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(1);

  // 390 — the phone layout: swipe-sized, arrows hidden on a touch-less narrow
  // viewport only by hover state, same dots and chip.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const phoneCard = page.locator(".post-web").filter({ has: page.getByTestId("video-track") }).first();
  await expect(phoneCard.getByRole("img", { name: "Video 1 of 3" })).toBeVisible();
  await phoneCard.scrollIntoViewIfNeeded();
  await phoneCard.screenshot({ path: `${SHOTS}/eng-1599-04-carousel-390.png` });
  // Swipe (scroll the track one slide) → the chip follows.
  await phoneCard.getByTestId("video-track").evaluate((el) => el.scrollTo({ left: el.clientWidth, behavior: "instant" }));
  await expect(phoneCard.getByRole("img", { name: "Video 2 of 3" })).toBeVisible();
  await phoneCard.screenshot({ path: `${SHOTS}/eng-1599-05-swiped-390.png` });
});

test("GUARDRAIL §3 — a lapsed member gets no poster and no playback url for any slide", async ({ page }) => {
  const tag = `${Date.now()}-lapsed`;
  const s = await seed(tag);
  const email = await member(tag, "lapsed");
  const mints = recordMints(page);

  await signIn(page, email);
  await page.goto(`/horses/${s.horseId}`);
  // The screen's own gate owns the wall.
  await expect(page.getByTestId("access-wall").first()).toBeVisible();
  await page.waitForLoadState("networkidle");

  await expect(page.getByTestId("video-track")).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);
  expect(mints.posters.filter((u) => u.includes("videoIndex"))).toEqual([]);
  expect(mints.streams).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/eng-1599-06-lapsed-wall.png` });
});

test("the slide's stream goes through hls.js with exactly the url minted for its videoIndex", async ({ page }) => {
  const tag = `${Date.now()}-hls`;
  const s = await seed(tag);
  const email = await member(tag, "active");
  const mints = recordMints(page);
  await reachLocalStorage(page);
  await stubStreamMint(page, "hls");
  const manifestFetches: string[] = [];
  page.on("request", (req) => {
    const kind = req.resourceType();
    if (req.url() === TEST_STREAM && (kind === "xhr" || kind === "fetch")) manifestFetches.push(req.url());
  });

  await signIn(page, email);
  await page.goto(`/horses/${s.horseId}`);
  const card = page.locator(".post-web").filter({ has: page.getByTestId("video-track") }).first();
  const media = card.locator(".post-media-web");
  await media.getByRole("button", { name: "Go to video 2 of 3" }).click();
  await media.getByRole("button", { name: "Play video 2 of 3" }).click();

  // Contains, not equals: since ENG-1633 the on-screen cards' index-0 urls are
  // pre-minted too, and moving to slide 2 pre-mints ITS url before the tap.
  await expect.poll(() => mints.streams).toContain(`/api/posts/${s.carouselId}/playback?videoIndex=1`);
  // hls.js (an XHR, not the element) fetched the manifest — the MSE transport.
  await expect.poll(() => manifestFetches.length, { timeout: 15_000 }).toBeGreaterThan(0);
  // No H.264 in this browser build: the transport fails honestly with the
  // feed's pill instead of a black box, and the slide falls back to its poster.
  // (The feeds draw the pill just BELOW the card, as a sibling of the article.)
  await expect(page.getByRole("alert").filter({ hasText: "Couldn’t load the video." })).toBeVisible({ timeout: 20_000 });
  await expect(media.locator("video")).toHaveCount(0);
  await expect(media.getByRole("button", { name: "Play video 2 of 3" })).toBeVisible();
});
