// ENG-1593 — first-feed timing on /explore (the before/after numbers for the PR).
//
// NOT a pass/fail gate: it measures, prints, and writes a JSON summary. It is
// skipped unless `ENG1593_PERF=1`, because the numbers only mean something
// against a PRODUCTION build (`next build && next start`) — a dev server's
// on-demand compile swamps every metric this ticket is about.
//
//   ENG1593_PERF=1 PERF_LABEL=before PORT=<next start port> npx playwright test e2e/eng-1593-perf.spec.ts
//
// What it records, per cold-cache load (a FRESH browser context each time, so
// no HTTP cache, no warm connections, no service worker):
//   ttfb      navigation responseStart
//   shell     first `.app-shell` in the DOM (sidebar frame)
//   skeleton  first feed skeleton card (absent when the cards arrive first)
//   card      first REAL post card (`article.post-web` in the feed column)
//   media     first feed-card <img> that finished decoding (naturalWidth > 0)
// All in ms since navigation start. The median of RUNS loads is the headline.
//
// Seeded fixture data only: one trainer + horse, six photo posts and two video
// posts with baked posters, and an explicitly entitled throwaway member (a
// seeded member is LAPSED by default — .rx/gotchas.md).
//
// ENG-1633 (PF-W1) extends every load with three more measurements, recorded
// for BOTH builds so the PR can show before/after:
//   posterOnly    `/api/posts/:id/playback?posterOnly=1` requests during the
//                 load (after: 0 — slot-0 posters ride in the batch, ENG-1629)
//   tapToPlay     click on the first video card's Play → its <video> playing
//                 (currentTime > 0). The STREAM mint is stubbed (no Mux signing
//                 key locally) with a fixed PERF_MINT_MS delay (default 250 ms,
//                 a stand-in for the BFF → edge → Mux round trip) and a VP8
//                 clip; identical for both builds.
//   mintsAfterTap stream-mint requests made BY the tap (after: 0 — the url was
//                 pre-minted while the card was on screen)
//   nextPageAt    cards still below the viewport when page 2 was requested,
//                 scrolling one card at a time (after: <= 5; before: ~0, the
//                 end-of-list sentinel), and pageTwoRequests (must be 1).
// Sixteen posts are seeded (two pages of 10), videos at 1 and 4, so there is a
// page 2 to prefetch.
import { test, expect, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const PASSWORD = "harness-password-123!";
const RUNS = Number(process.env.PERF_RUNS ?? 7);
const LABEL = process.env.PERF_LABEL ?? "run";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

type Marks = {
  ttfb: number;
  shell?: number;
  skeleton?: number;
  card?: number;
  media?: number;
  // ENG-1633
  posterOnly?: number;
  tapToPlay?: number;
  mintsAfterTap?: number;
  nextPageAt?: number | null;
  pageTwoRequests?: number;
};

const MINT_MS = Number(process.env.PERF_MINT_MS ?? 250);
const CLIP = readFileSync(join(__dirname, "fixtures", "eng-1599-clip.webm"));
const CLIP_ORIGIN = "https://media.stablepass.test";

/**
 * Stub ONLY the stream half of the playback mint (the local stack has no Mux
 * signing key — .rx/gotchas.md ENG-1599); `posterOnly` goes to the real be.
 * Every stream mint waits MINT_MS, so a tap that must mint pays it and a tap on
 * a pre-minted url does not — which is exactly the difference being measured.
 */
async function stubStreamMint(page: Page, streams: string[]) {
  await page.route("**/api/posts/*/playback**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("posterOnly") === "1") return route.continue();
    streams.push(url.pathname + url.search);
    await new Promise((r) => setTimeout(r, MINT_MS));
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    try {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { playbackUrl: `${CLIP_ORIGIN}/clip.webm`, posterUrl: null, expiresAt } }),
      });
    } catch {
      // The context closed mid-flight.
    }
  });
  await page.route(`${CLIP_ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: "video/webm", body: CLIP }));
}

// VISIBLE, not merely present. A streamed Suspense segment lands in the DOM
// inside `<div hidden id="S:…">` and is revealed a moment later, so "the node
// exists" would credit the server render with a paint the member has not seen
// yet. Every mark therefore requires the element to be outside any `[hidden]`
// ancestor, and `media` additionally requires a DECODED image
// (`complete && naturalWidth > 0`). Sampled every animation frame.
const INIT = () => {
  const w = window as unknown as { __m: Record<string, number> };
  w.__m = {};
  const mark = (k: string) => {
    if (!(k in w.__m)) w.__m[k] = performance.now();
  };
  const visible = (el: Element | null) => Boolean(el) && el!.closest("[hidden]") === null;
  const first = (sel: string) => Array.from(document.querySelectorAll(sel)).find(visible) ?? null;
  const tick = () => {
    if (first(".app-shell")) mark("shell");
    if (first(".feed-col .post-web[aria-hidden='true']")) mark("skeleton");
    if (first(".feed-col article.post-web")) mark("card");
    const img = Array.from(document.querySelectorAll(".feed-col article.post-web img")).find(
      (el) => visible(el) && (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
    );
    if (img) mark("media");
    if (!("media" in w.__m)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

/**
 * LOCAL-STACK ONLY. The edge functions sign Storage urls against THEIR
 * `SUPABASE_URL`, which inside the local edge runtime is the docker-internal
 * `http://kong:8000` — unresolvable from the browser, so no minted image would
 * ever load. Re-point those requests at the host-mapped gateway. Identical
 * before and after, so it cannot favour either build.
 */
async function routeKong(page: Page) {
  await page.route(/^http:\/\/kong:8000\//, async (route) => {
    try {
      const response = await route.fetch({ url: route.request().url().replace("http://kong:8000", SUPABASE_URL) });
      await route.fulfill({ response });
    } catch {
      // The context closed mid-flight (the load already finished measuring).
    }
  });
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.floor(s.length / 2)]) : NaN;
}

async function oneLoad(browser: Browser, baseURL: string, storageState: string, userId: string): Promise<Marks> {
  // The feed is UNSEEN-FIRST and every load records impressions, so without
  // this the seeded posts sink below the shared DB's other fixtures after the
  // first load and each run would measure a different page. Reset per load.
  const { error: impErr } = await admin.from("impression").delete().eq("user_id", userId);
  if (impErr) throw impErr;
  const ctx = await browser.newContext({ baseURL, storageState });
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  await routeKong(page);
  // ENG-1633 — every playback request, split poster / stream, and page-2 reads.
  let posterOnly = 0;
  const streams: string[] = [];
  const pageTwo: number[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (/^\/api\/posts\/[^/]+\/playback$/.test(url.pathname) && url.searchParams.get("posterOnly") === "1") posterOnly++;
    if (url.pathname === "/api/feed" && url.searchParams.has("cursor")) pageTwo.push(Date.now());
  });
  await stubStreamMint(page, streams);
  // PERF_LATENCY=<ms> adds a round-trip delay to every BROWSER request (CDP
  // network emulation) — localhost has ~0ms RTT, which hides exactly the serial
  // round trips this ticket removes. Server→Supabase hops stay local either way.
  const latency = Number(process.env.PERF_LATENCY ?? 0);
  if (latency > 0) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  }
  await page.goto("/explore", { waitUntil: "commit" });
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __m: Record<string, number> }).__m.media ?? null), {
      timeout: 30_000,
    })
    .not.toBeNull();
  const marks = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    return { ttfb: nav.responseStart, ...(window as unknown as { __m: Record<string, number> }).__m };
  });
  // Let page 1's own requests (and, after, the pre-mint) settle before counting.
  await page.waitForLoadState("networkidle");
  const posterOnlyOnLoad = posterOnly;

  // tap → play, on the first VIDEO card (the seeded video at index 1).
  const videoCard = page.locator(".feed-col article.post-web").filter({ has: page.getByRole("button", { name: "Play video", exact: true }) }).first();
  await videoCard.scrollIntoViewIfNeeded();
  // The pre-mint (after) is driven by the card being on screen; give it the
  // same settle both builds get.
  await page.waitForLoadState("networkidle");
  const before = streams.length;
  const t0 = Date.now();
  await videoCard.getByRole("button", { name: "Play video", exact: true }).click();
  const video = page.locator(".feed-col article.post-web video").first();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime).catch(() => 0), { timeout: 20_000, intervals: [16] }).toBeGreaterThan(0);
  const tapToPlay = Date.now() - t0;
  const mintsAfterTap = streams.length - before;

  // Page 2: scroll ONE card at a time; note how many cards were still below the
  // viewport when the page-2 read went out.
  let nextPageAt: number | null = null;
  for (let i = 0; i < 12 && pageTwo.length === 0; i++) {
    const cards = page.locator(".feed-col article.post-web");
    const n = await cards.count();
    if (i >= n) break;
    await cards.nth(i).evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
    await page.waitForTimeout(150);
    if (pageTwo.length > 0) {
      nextPageAt = await page.evaluate(() =>
        Array.from(document.querySelectorAll(".feed-col article.post-web")).filter(
          (el) => el.getBoundingClientRect().top >= window.innerHeight,
        ).length,
      );
    }
  }
  await page.waitForLoadState("networkidle");
  // Scroll the rest of the way: the sentinel must NOT fire a second page-2 read.
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await page.waitForTimeout(300);
  const pageTwoRequests = pageTwo.length;
  await ctx.close();
  return { ...(marks as Marks), posterOnly: posterOnlyOnLoad, tapToPlay, mintsAfterTap, nextPageAt, pageTwoRequests };
}

test.skip(process.env.ENG1593_PERF !== "1", "measurement run only — set ENG1593_PERF=1 against `next start`");

test("ENG-1593 first-feed timing on /explore", async ({ browser, baseURL, page }) => {
  test.setTimeout(10 * 60_000);
  const stamp = Date.now();
  const photo = readFileSync(join(process.cwd(), "public", "marketing", "6ec6412f.jpg"));

  const { data: trainer, error: tErr } = await admin
    .from("trainer")
    .insert({ name: "Perf Stables ENG1593", slug: `perf-eng1593-${stamp}`, status: "active" })
    .select("id")
    .single();
  if (tErr) throw tErr;
  const { data: horse, error: hErr } = await admin
    .from("horse")
    .insert({ trainer_id: trainer.id, display_name: `Perfpace ${stamp}`, racing_name: "PERFPACE", status: "active" })
    .select("id")
    .single();
  if (hErr) throw hErr;

  const postIds: string[] = [];
  const now = Date.now();
  for (let i = 0; i < 16; i++) {
    const video = i === 1 || i === 4;
    const { data: post, error } = await admin
      .from("post")
      .insert({
        horse_id: horse.id,
        source_trainer_id: trainer.id,
        type: video ? "video" : "photo",
        status: "published",
        body: `ENG-1593 perf post ${i}`,
        media_url: null,
        mux_playback_id: video ? `pb-eng1593-${stamp}-${i}` : null,
        watermarked: false,
        // Newest first, so these eight lead page 1 over any other fixture rows.
        published_at: new Date(now - (i + 1) * 1_000).toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    postIds.push(post.id);
    const key = video ? `posters/${post.id}.jpg` : `${post.id}/original`;
    const { error: upErr } = await admin.storage
      .from("post-media")
      .upload(key, photo, { contentType: "image/jpeg", upsert: true });
    if (upErr) throw upErr;
    const { error: setErr } = await admin
      .from("post")
      .update(video ? { poster_url: key } : { media_url: key })
      .eq("id", post.id);
    if (setErr) throw setErr;
    // ENG-1633 — a real multi-video-era post: slot 0 in `post_video`, ready,
    // with its baked poster, which is what the ENG-1629 batch signs as
    // `posterUrl`. (The mirror trigger keeps `post`'s columns in step.)
    if (video) {
      const { error: pvErr } = await admin.from("post_video").insert({
        post_id: post.id,
        sort_order: 0,
        status: "ready",
        mux_playback_id: `pb-eng1593-${stamp}-${i}`,
        poster_url: key,
      });
      if (pvErr) throw pvErr;
    }
  }

  const email = `eng1593-perf-${stamp}@stablepass.test`;
  const { data: u, error: uErr } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (uErr) throw uErr;
  const { error: subErr } = await admin
    .from("subscription")
    .update({ status: "active", current_period_end: "2099-01-01T00:00:00Z" })
    .eq("user_id", u.user!.id);
  if (subErr) throw subErr;

  const statePath = join(".rx", "review", `eng-1593-perf-state-${stamp}.json`);
  mkdirSync(join(".rx", "review"), { recursive: true });
  try {
    await page.goto("/signin");
    await page.getByLabel("Email").fill(email);
    await page.locator("input[type=password]").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");
    // Let the sign-in load's own impression writes land before the per-load reset.
    await page.waitForLoadState("networkidle");
    await page.context().storageState({ path: statePath });

    // One discarded warm-up load: the first request after `next start` pays
    // one-off module initialisation that no member ever sees twice.
    await oneLoad(browser, baseURL!, statePath, u.user!.id);

    const runs: Marks[] = [];
    for (let i = 0; i < RUNS; i++) runs.push(await oneLoad(browser, baseURL!, statePath, u.user!.id));

    const pick = (k: keyof Marks) => runs.map((r) => r[k]).filter((v): v is number => typeof v === "number");
    const summary = {
      label: LABEL,
      runs: RUNS,
      median: {
        ttfb: median(pick("ttfb")),
        shell: median(pick("shell")),
        skeleton: pick("skeleton").length ? median(pick("skeleton")) : null,
        card: median(pick("card")),
        media: median(pick("media")),
        // ENG-1633
        posterOnly: median(pick("posterOnly")),
        tapToPlay: median(pick("tapToPlay")),
        mintsAfterTap: median(pick("mintsAfterTap")),
        nextPageAt: pick("nextPageAt").length ? median(pick("nextPageAt")) : null,
        pageTwoRequests: median(pick("pageTwoRequests")),
      },
      raw: runs,
    };
    console.log(`[eng-1593 perf ${LABEL}]`, JSON.stringify(summary.median));
    writeFileSync(join(".rx", "review", `eng-1593-perf-${LABEL}.json`), JSON.stringify(summary, null, 2));
  } finally {
    await admin.from("post").delete().in("id", postIds).then(undefined, () => {});
    await admin.from("horse").delete().eq("id", horse.id).then(undefined, () => {});
    await admin.from("trainer").delete().eq("id", trainer.id).then(undefined, () => {});
    await admin.auth.admin.deleteUser(u.user!.id).then(undefined, () => {});
  }
});
