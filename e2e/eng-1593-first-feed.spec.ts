// ENG-1593 — the server-rendered first feed page on /explore, end to end.
//
// Three properties, each asserted against the REAL response a member gets (the
// local stack, with the be edge functions served — `supabase functions serve`
// from stablepass-be, see .rx/gotchas.md):
//
//   1. GUARDRAIL. A LAPSED member's /explore HTML — and every response their
//      browser receives afterwards — carries no post-media or playback url.
//      Paired with a positive control (an ENTITLED member's HTML DOES carry the
//      seeded photo's minted url), so the negative can never pass vacuously
//      because nothing was rendered for anyone.
//   2. STREAMING. The shell and the skeleton are flushed BEFORE the feed: the
//      skeleton is a Suspense fallback in the document, and the first card's
//      markup arrives after it in the stream.
//   3. THE ROOT REWRITE. `/` on the app host serves Explore directly (200, no
//      Location), and the sidebar still marks Explore as the current page.
//
// Seeded fixture data only; everything is created here and deleted after.
import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
// Well-known local-Supabase demo service-role key (local dev only — never a real secret).
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const PASSWORD = "harness-password-123!";
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Any minted post-media object (photo, slide or baked poster) and any Mux
// playback url. `sign/post-media` is the Storage path every mint produces.
const MEDIA_URL_PATTERNS = [/\/object\/sign\/post-media\//, /stream\.mux\.com/, /posterOnly/];

type Seed = { trainerId: string; horseId: string; photoId: string; videoId: string; body: string };

async function seedPosts(): Promise<Seed> {
  const stamp = Date.now();
  const photo = readFileSync(join(process.cwd(), "public", "marketing", "6ec6412f.jpg"));
  const { data: trainer, error: tErr } = await admin
    .from("trainer")
    .insert({ name: "First Feed ENG1593", slug: `first-feed-eng1593-${stamp}`, status: "active" })
    .select("id")
    .single();
  if (tErr) throw tErr;
  const { data: horse, error: hErr } = await admin
    .from("horse")
    .insert({ trainer_id: trainer.id, display_name: `Firstlight ${stamp}`, racing_name: "FIRSTLIGHT", status: "active" })
    .select("id")
    .single();
  if (hErr) throw hErr;

  const body = `ENG-1593 first card ${stamp}`;
  const ids: string[] = [];
  for (const [i, type] of (["photo", "video"] as const).entries()) {
    const { data: post, error } = await admin
      .from("post")
      .insert({
        horse_id: horse.id,
        source_trainer_id: trainer.id,
        type,
        status: "published",
        body: type === "photo" ? body : `ENG-1593 video ${stamp}`,
        media_url: null,
        mux_playback_id: type === "video" ? `pb-eng1593-${stamp}` : null,
        watermarked: false,
        // Newest in the shared DB, so they lead page 1.
        published_at: new Date(Date.now() - (i + 1) * 1000).toISOString(),
      })
      .select("id")
      .single();
    if (error) throw error;
    const key = type === "video" ? `posters/${post.id}.jpg` : `${post.id}/original`;
    const { error: upErr } = await admin.storage.from("post-media").upload(key, photo, { contentType: "image/jpeg", upsert: true });
    if (upErr) throw upErr;
    const { error: setErr } = await admin
      .from("post")
      .update(type === "video" ? { poster_url: key } : { media_url: key })
      .eq("id", post.id);
    if (setErr) throw setErr;
    ids.push(post.id);
  }
  return { trainerId: trainer.id, horseId: horse.id, photoId: ids[0], videoId: ids[1], body };
}

async function cleanup(seed: Seed | null, userId: string | null) {
  if (seed) {
    await admin.from("post").delete().in("id", [seed.photoId, seed.videoId]).then(undefined, () => {});
    await admin.from("horse").delete().eq("id", seed.horseId).then(undefined, () => {});
    await admin.from("trainer").delete().eq("id", seed.trainerId).then(undefined, () => {});
  }
  if (userId) await admin.auth.admin.deleteUser(userId).then(undefined, () => {});
}

/** A confirmed member; `entitled` promotes the default (LAPSED) subscription row. */
async function seedMember(prefix: string, entitled: boolean) {
  const email = `${prefix}-${Date.now()}@stablepass.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  const userId = data.user!.id;
  if (entitled) {
    const { error: subErr } = await admin
      .from("subscription")
      .update({ status: "active", current_period_end: "2099-01-01T00:00:00Z" })
      .eq("user_id", userId);
    if (subErr) throw subErr;
  }
  return { email, userId };
}

async function signIn(page: Page, email: string) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(email);
  await page.locator("input[type=password]").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/explore");
  await page.waitForLoadState("networkidle");
}

/** The feed is unseen-first and every load records impressions — reset so the seed leads page 1. */
async function resetImpressions(userId: string) {
  const { error } = await admin.from("impression").delete().eq("user_id", userId);
  if (error) throw error;
}

test.describe.configure({ mode: "serial" });

test("guardrail: a LAPSED member's /explore HTML and client payload carry no media or playback url", async ({ page }) => {
  let seed: Seed | null = null;
  let userId: string | null = null;
  try {
    seed = await seedPosts();
    const member = await seedMember("eng1593-lapsed", false);
    userId = member.userId;

    // Every response body the browser receives from here on — BFF, Supabase,
    // edge — is collected, so the CLIENT payload is covered, not just the HTML.
    const bodies: { url: string; text: string }[] = [];
    page.on("response", async (r) => {
      const type = r.request().resourceType();
      if (type !== "fetch" && type !== "xhr" && type !== "document") return;
      bodies.push({ url: r.url(), text: await r.text().catch(() => "") });
    });

    await signIn(page, member.email);

    // THE SSR HTML, fetched raw with the member's own cookies.
    const res = await page.request.get("/explore");
    expect(res.status()).toBe(200);
    const html = await res.text();
    // POSITIVE first: this is the wall, not an error page or an empty shell.
    expect(html).toContain("have a subscription yet");
    for (const pattern of MEDIA_URL_PATTERNS) expect(html).not.toMatch(pattern);
    expect(html).not.toContain(seed.body);
    expect(html).not.toContain(seed.photoId);

    // THE CLIENT PAYLOAD: a real browser load, then every body it received.
    await page.goto("/explore");
    await expect(page.getByText("have a subscription yet", { exact: false })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(bodies.length).toBeGreaterThan(0);
    for (const { url, text } of bodies) {
      for (const pattern of MEDIA_URL_PATTERNS) {
        expect(text, `a media url reached a lapsed member via ${url}`).not.toMatch(pattern);
      }
    }
    const srcs = await page.locator("img").evaluateAll((els) => els.map((e) => (e as HTMLImageElement).src));
    for (const src of srcs) expect(src).not.toMatch(/sign\/post-media/);
  } finally {
    await cleanup(seed, userId);
  }
});

test("positive control: an ENTITLED member's /explore HTML already carries page 1 with its minted photo url", async ({ page }) => {
  let seed: Seed | null = null;
  let userId: string | null = null;
  try {
    seed = await seedPosts();
    const member = await seedMember("eng1593-entitled", true);
    userId = member.userId;
    await signIn(page, member.email);
    await resetImpressions(member.userId);

    const html = await (await page.request.get("/explore")).text();
    // Server-rendered: the card AND its minted image are in the document.
    expect(html).toContain(seed.body);
    expect(html).toMatch(new RegExp(`/object/sign/post-media/${seed.photoId}/original\\?token=`));
    // The first card's image is the high-priority, eager one.
    expect(html).toMatch(/<img[^>]*fetchPriority="high"|<img[^>]*fetchpriority="high"/i);
  } finally {
    await cleanup(seed, userId);
  }
});

test("streaming: the shell and the skeleton are flushed before the first card", async ({ page, baseURL }) => {
  let seed: Seed | null = null;
  let userId: string | null = null;
  try {
    seed = await seedPosts();
    const member = await seedMember("eng1593-stream", true);
    userId = member.userId;
    await signIn(page, member.email);
    await resetImpressions(member.userId);

    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await fetch(`${baseURL}/explore`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const chunks: { at: number; text: string }[] = [];
    const t0 = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push({ at: Date.now() - t0, text: decoder.decode(value, { stream: true }) });
    }
    const html = chunks.map((c) => c.text).join("");
    const firstChunkWith = (needle: string) => chunks.findIndex((c) => c.text.includes(needle));

    const shellAt = html.indexOf('class="app-shell"');
    const skeletonAt = html.indexOf('aria-busy="true"');
    const cardAt = html.indexOf(seed.body);
    expect(shellAt).toBeGreaterThan(-1);
    expect(skeletonAt).toBeGreaterThan(shellAt);
    // The card arrives LATER in the stream than the skeleton that stood in for it…
    expect(cardAt).toBeGreaterThan(skeletonAt);
    // …as a streamed Suspense segment: React's pending-boundary marker precedes
    // the fallback, and the resolved content arrives in a hidden segment.
    expect(html).toMatch(/<!--\$\?--><template id="B:[^"]+"><\/template>/);
    expect(html).toMatch(/<div hidden id="S:/);
    console.log(
      `[eng-1593 stream] chunks=${chunks.length} shell@chunk${firstChunkWith('class="app-shell"')} ` +
        `skeleton@chunk${firstChunkWith('aria-busy="true"')} card@chunk${firstChunkWith(seed.body)} ` +
        `times=${chunks.map((c) => c.at).join(",")}ms`,
    );
  } finally {
    await cleanup(seed, userId);
  }
});

test("the app-host root SERVES Explore (no redirect) and the sidebar still marks Explore current", async ({ page }) => {
  let userId: string | null = null;
  try {
    const member = await seedMember("eng1593-root", true);
    userId = member.userId;
    await signIn(page, member.email);

    // `x-forwarded-host` is how middleware learns the public host behind a proxy.
    const res = await page.request.get("/", {
      headers: { "x-forwarded-host": "app.stablepass.co" },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(200);
    expect(res.headers()["location"]).toBeUndefined();
    const html = await res.text();
    expect(html).toContain('class="app-shell"');
    expect(html).toMatch(/<a[^>]*href="\/explore"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/explore"/);
  } finally {
    await cleanup(null, userId);
  }
});

test("evidence: the streamed skeleton frame, the server-rendered first cards, and the lapsed wall", async ({ page, browser, baseURL }) => {
  let seed: Seed | null = null;
  const users: string[] = [];
  try {
    seed = await seedPosts();
    const member = await seedMember("eng1593-shots", true);
    users.push(member.userId);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, member.email);
    await resetImpressions(member.userId);

    // 1. THE SKELETON FRAME — exactly what the browser has painted before the
    // feed resolves: the real streamed response, cut at the chunk that brings
    // the first card, served to a fresh page with JS off (so nothing hydrates
    // past it). This is the pre-data frame, not a mock of it.
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await fetch(`${baseURL}/explore`, { headers: { cookie } });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let head = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.includes(seed.body)) break;
      head += text;
    }
    await reader.cancel().catch(() => {});
    const frameCtx = await browser.newContext({ baseURL, javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
    const frame = await frameCtx.newPage();
    await frame.route("**/explore-skeleton-frame", (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: head + "</body></html>" }),
    );
    await frame.goto("/explore-skeleton-frame");
    await expect(frame.locator('.feed-grid[aria-busy="true"]')).toBeVisible();
    await frame.screenshot({ path: ".rx/review/eng-1593-skeleton-frame.png" });
    await frameCtx.close();

    // 2. THE FIRST CARDS, server-rendered, with the first photo decoded.
    await resetImpressions(member.userId);
    await page.route(/^http:\/\/kong:8000\//, async (route) => {
      try {
        const r = await route.fetch({ url: route.request().url().replace("http://kong:8000", SUPABASE_URL) });
        await route.fulfill({ response: r });
      } catch {
        /* page closed */
      }
    });
    await page.goto("/explore");
    // The REVEALED card — not the copy still parked in the hidden stream segment.
    await expect(page.locator(".feed-col article.post-web").first()).toBeVisible();
    await expect(page.locator('.feed-grid[aria-busy="true"]')).toHaveCount(0);
    const firstImg = page.locator(".feed-col article.post-web img[fetchpriority='high']").first();
    await expect(async () => {
      expect(await firstImg.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0)).toBe(true);
    }).toPass({ timeout: 20_000 });
    await page.screenshot({ path: ".rx/review/eng-1593-explore-populated.png" });

    // 3. THE WALL for a lapsed member (server-decided, no client fetch).
    const lapsed = await seedMember("eng1593-shots-lapsed", false);
    users.push(lapsed.userId);
    const wallCtx = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    const wall = await wallCtx.newPage();
    await signIn(wall, lapsed.email);
    await expect(wall.getByText("have a subscription yet", { exact: false })).toBeVisible();
    await wall.screenshot({ path: ".rx/review/eng-1593-explore-lapsed-wall.png" });
    await wallCtx.close();
  } finally {
    await cleanup(seed, null);
    for (const id of users) await admin.auth.admin.deleteUser(id).then(undefined, () => {});
  }
});
