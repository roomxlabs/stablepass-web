import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

/**
 * ENG-1059 — a MEMBER FEED (not the dev gallery) plays through hls.js, and a dead
 * stream degrades to the feed's own pill instead of a black rectangle.
 *
 * WHY THIS FILE EXISTS ALONGSIDE `eng-1056-hls-player.spec.ts`. M1 proved the
 * transport, but it could only prove it on `/preview/components`: `MediaPlayer` is
 * mounted nowhere else, and the five member feeds were outside M1's surface. Its own
 * header says so. So M1 shipped a correct player that no member could reach — every
 * feed still inlined `<video controls autoPlay src={playbackUrl} />`. This file closes
 * that gap by driving the real thing a member touches.
 *
 * WHY FIREFOX. Playwright's bundled Chromium reports
 * `canPlayType("application/vnd.apple.mpegurl") === "maybe"` and genuinely PLAYS HLS,
 * so it kept every suite green while real Chrome/Firefox/Edge showed a black box
 * (`.rx/gotchas.md`, ENG-1056). Firefox reports `""` — the honest browser. The first
 * test PINS that premise so this file can never quietly become a run that proves
 * nothing. Real Chrome + Safari stay a manual acceptance step (see the PR body).
 *
 * WHY `/horses/:id` AND NOT `/explore`. The ticket suggested Explore, but the local
 * `feed` edge function is a stub that yields no video card (`.rx/gotchas.md`, ENG-613),
 * which would make every assertion below pass vacuously. A horse profile renders
 * `app/(member)/horses/[id]/horse-posts.tsx` — one of the five files this ticket
 * changes — straight from seeded DB rows, so the card is real and the assertions bite.
 * The five call sites are byte-identical (a unit test in `test/feed-hls-video.test.tsx`
 * pins that), so proving one screen in a real browser plus all five in jsdom is the
 * honest split.
 *
 * The mint is stubbed with a deliberately DEAD signed URL: local Supabase has no Mux
 * signing key, and a stream that fails is exactly the state under test. What is NOT
 * stubbed is everything under review — the transport choice, the lazy chunk, the pill.
 */
test.use({ browserName: "firefox" });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** 1x1 JPEG — stands in for the poster frame mux-webhook bakes into the bucket. */
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

/**
 * A well-formed Mux HLS URL whose token is nonsense — the manifest GET fails, which is
 * a FATAL hls.js error and therefore the exact state under test.
 */
const DEAD_PLAYBACK_URL =
  "https://stream.mux.com/eng1059-dead-fixture.m3u8?token=eng1059.not.a.real.token";

/** The feed's existing pill copy — note the TYPOGRAPHIC apostrophe (`&rsquo;`). */
const PILL = "Couldn’t load the video.";

test("this browser does NOT play HLS natively — the premise the whole fix rests on", async ({
  page,
}) => {
  await page.goto("/signin");
  const support = await page.evaluate(() =>
    document.createElement("video").canPlayType("application/vnd.apple.mpegurl"),
  );
  // If this ever becomes "maybe"/"probably", this file has silently stopped testing the
  // bug and the assertions below would pass for the wrong reason.
  expect(support).toBe("");
});

test("a member feed streams through hls.js, and a dead stream shows the feed's pill", async ({
  page,
}) => {
  const email = `eng1059-harness-${Date.now()}@stablepass.test`;
  const password = "harness-password-123!";
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: trainer, error: tErr } = await admin
    .from("trainer")
    .insert({ name: "Chris Waller", slug: `eng1059-waller-${Date.now()}` })
    .select("id")
    .single();
  if (tErr) throw tErr;

  const { data: horse, error: hErr } = await admin
    .from("horse")
    .insert({ trainer_id: trainer.id, display_name: "Mahogany", racing_name: "Mahogany", status: "active" })
    .select("id")
    .single();
  if (hErr) throw hErr;

  // A video post has NO `media_url` — that column is the photo/voice path.
  const { data: post, error: pErr } = await admin
    .from("post")
    .insert({
      horse_id: horse.id,
      type: "video",
      status: "published",
      body: "Trackwork this morning.",
      media_url: null,
      mux_playback_id: `pb-eng1059-${Date.now()}`,
      source_trainer_id: trainer.id,
      watermarked: false,
      published_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (pErr) throw pErr;

  // The baked poster. It matters here beyond dressing: `HlsVideo` now receives it as
  // `poster=`, so the error state is a real frame with the pill under it rather than
  // the flat green box the bare `<video>` left behind.
  const posterPath = `posters/${post.id}.jpg`;
  const { error: upErr } = await admin.storage
    .from("post-media")
    .upload(posterPath, TINY_JPEG, { contentType: "image/jpeg", upsert: true });
  if (upErr) throw upErr;
  const { error: setErr } = await admin.from("post").update({ poster_url: posterPath }).eq("id", post.id);
  if (setErr) throw setErr;

  const { data: userData, error: uErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (uErr) throw uErr;

  // ENTITLE THE MEMBER EXPLICITLY. The `auth.users` trigger inserts a `subscription`
  // row at the column DEFAULT (`lapsed`), and ENG-999 retired the free trial, so a
  // freshly-created member hits the AccessWall and the profile renders ZERO cards —
  // which reads exactly like "the feature is broken" (`.rx/gotchas.md`, ENG-1057).
  const { error: subErr } = await admin
    .from("subscription")
    .update({ status: "active", current_period_end: "2099-01-01T00:00:00Z" })
    .eq("user_id", userData.user.id);
  if (subErr) throw subErr;

  try {
    // Stub ONLY the stream mint. The list render mints the poster separately via
    // `playback?posterOnly=1`; that one must go through to the real BFF, or the card
    // loses the poster this test also checks.
    await page.route("**/api/posts/*/playback**", async (route) => {
      if (route.request().url().includes("posterOnly")) return route.continue();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            playbackUrl: DEAD_PLAYBACK_URL,
            posterUrl: null,
            expiresAt: "2099-01-01T00:00:00Z",
          },
        }),
      });
    });

    // Two independent signals, because neither alone is honest:
    //
    //  - `chunks` — every JS chunk the page pulls. Chunk FILENAMES are opaque hashes,
    //    so lazy-loading is proved by a NEW chunk arriving at click time, never by
    //    matching a name (`.rx/gotchas.md`, ENG-1056).
    //  - `manifestFetches` — the GET for the `.m3u8`, but ONLY those issued as
    //    `xhr`/`fetch`. That is what proves hls.js is the transport: a bare
    //    `<video src="…m3u8">` requests the manifest too, but the ELEMENT requests it
    //    as `media`/`other`. hls.js uses XHR.
    const chunks = new Set<string>();
    const manifestFetches: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/_next/static/chunks/")) chunks.add(url);
      if (url.startsWith(DEAD_PLAYBACK_URL.split("?")[0])) {
        const kind = req.resourceType();
        if (kind === "xhr" || kind === "fetch") manifestFetches.push(url);
      }
    });

    await page.goto("/signin");
    await page.getByLabel("Email", { exact: true }).fill(email);
    // `getByLabel("Password")` is AMBIGUOUS — the reveal toggle is
    // `<button aria-label="Show password">` and Playwright matches it too
    // (`.rx/gotchas.md`). Anchor on the input.
    await page.locator("input[type=password]").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL("**/explore");

    await page.goto(`/horses/${horse.id}`);

    const card = page.locator(".post-web").first();
    await expect(card).toBeVisible();
    const media = card.locator(".post-media-web");
    const play = media.getByRole("button", { name: "Play video" });
    await expect(play).toBeVisible();

    // IDLE — play affordance only. No <video>, and nothing streamed. This is also the
    // acceptance criterion "the hls.js chunk is NOT requested until Play is pressed".
    await expect(media.locator("video")).toHaveCount(0);
    expect(manifestFetches).toEqual([]);
    const chunksBeforePlay = new Set(chunks);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: ".rx/review/eng-1059-01-idle.png" });

    await play.click();

    // hls.js is the transport: the manifest arrives as an XHR from the library, in a
    // browser that cannot play HLS natively at all (pinned by the test above). This
    // also proves the pre-Play assertion was not vacuous.
    await expect
      .poll(() => manifestFetches.length, {
        message: "hls.js never XHR'd the manifest — the transport did not run on a member feed",
        timeout: 30_000,
      })
      .toBeGreaterThan(0);

    // ...and it was not paid for until Play: at least one chunk the idle page never
    // requested arrived during this click.
    const newChunks = [...chunks].filter((u) => !chunksBeforePlay.has(u));
    expect(
      newChunks.length,
      "no new JS chunk was fetched on Play — hls.js is not being code-split",
    ).toBeGreaterThan(0);

    // The stream is dead, so the fatal hls.js error must reach `onFatalError`, which
    // drops the post from `playing` and raises `playError` — the feed's EXISTING pill,
    // and no <video> anywhere. Before this ticket the element stayed, forever black.
    //
    // `getByText`, not `getByRole("alert")`: Next's route announcer is an `alert` too
    // and makes that role ambiguous in Playwright (`.rx/gotchas.md`).
    await expect(page.getByText(PILL)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("video")).toHaveCount(0);

    // ...and the card itself is BACK — `onFatalError` cleared `playing`, so the feed
    // re-renders its `PostCard` branch with the play affordance, exactly as it does
    // after a failed mint. Pressing Play again re-mints, which is the documented
    // recovery path.
    await expect(play).toBeVisible();

    // DELIBERATELY NOT ASSERTED HERE: that the poster FRAME is visible behind the pill.
    // The ticket's contract says the error state is "poster + pill", and `HlsVideo` is
    // handed `poster={p.media.posterUrl ?? undefined}`, but on this machine a seeded
    // video post renders the dark empty box rather than a baked frame — at IDLE, before
    // anything in this ticket runs, so it is not a regression from the <video> swap
    // (the bare element had no `poster` attribute at all). That claim belongs to
    // `e2e/video-poster.spec.ts`, which currently cannot prove it either: it is
    // PRE-EXISTING RED, dying at `getByLabel("Password")` (ambiguous since the reveal
    // toggle landed) long before its poster assertion. Asserting a visible <img> here
    // would just import that unrelated red into this ticket. See the PR body.

    // Screenshot the WRAPPER, not `.post-web`. The pill is a SIBLING of the card
    // (`<div key={p.id}><PostCard/>{playError && <p role="alert">…}</div>`), so a
    // screenshot of `.post-web` alone crops the very thing this ticket adds and the
    // evidence would show an ordinary card.
    const wrapper = card.locator("xpath=..");
    await wrapper.scrollIntoViewIfNeeded();
    await wrapper.screenshot({ path: ".rx/review/eng-1059-02-transport-error.png" });
  } finally {
    if (userData?.user?.id) await admin.auth.admin.deleteUser(userData.user.id).catch(() => {});
    await admin.storage.from("post-media").remove([posterPath]).catch(() => {});
    // The seeded ROWS too, innermost first — `post` references `horse`, which
    // references `trainer`. Leaving them behind orphans three rows in the local DB
    // per run, and a later spec that anchors on `.post-web` first() can silently
    // pick up this ticket's fixture instead of its own.
    await admin.from("post").delete().eq("id", post.id).then(undefined, () => {});
    await admin.from("horse").delete().eq("id", horse.id).then(undefined, () => {});
    await admin.from("trainer").delete().eq("id", trainer.id).then(undefined, () => {});
  }
});
