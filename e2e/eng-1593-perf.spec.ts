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

type Marks = { ttfb: number; shell?: number; skeleton?: number; card?: number; media?: number };

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
  await ctx.close();
  return marks as Marks;
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
  for (let i = 0; i < 8; i++) {
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
