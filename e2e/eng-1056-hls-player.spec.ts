import { test, expect } from "@playwright/test";

/**
 * ENG-1056 — `MediaPlayer` plays HLS in a browser that cannot play it natively,
 * and fails HONESTLY when the stream is dead.
 *
 * WHY FIREFOX. Playwright's bundled Chromium reports
 * `canPlayType("application/vnd.apple.mpegurl") === "maybe"` and genuinely PLAYS HLS, so
 * it happily rendered the old bare `<video src="…m3u8">` and kept every suite green while
 * real desktop Chrome, Firefox and Edge showed members a black box with a spinner
 * forever. Firefox is the honest browser: `canPlayType(HLS)` is `""`, exactly what a
 * member's browser reports, so it exercises the hls.js transport and the new error path
 * for real. The first test PINS that premise so this file can never quietly become a
 * Chromium run that proves nothing. (Real Chrome + Safari playback stays a manual
 * acceptance step — see the PR body.)
 *
 * WHY THE COMPONENT GALLERY AND NOT A MEMBER FEED. `/preview/components` is the ONLY
 * place `components/media-player.tsx` is mounted — verified by grep on this base. Every
 * member feed (`app/(member)/{explore,following,saved}/…`, `horse-posts.tsx`,
 * `trainer-posts.tsx`) inlines its OWN `<video controls autoPlay src={playbackUrl} />`
 * and mints with a GET rather than rendering this component. Those five files are outside
 * this ticket's declared surface (`app/(member)/**` is fenced to M2, and
 * `explore-feed.tsx` is locked by in-progress ENG-1057), so they are NOT fixed here — see
 * the PR body and the follow-up noted on the ticket. The gallery is also the repo's
 * documented answer to "assert a card honestly" (`.rx/gotchas.md`, ENG-613: the local
 * `feed` edge function is a stub, so `/explore` asserts vacuously).
 *
 * The mint is stubbed with a deliberately DEAD signed URL: local Supabase has no Mux
 * signing key, and a stream that fails is precisely the state under test. What is NOT
 * stubbed is everything under review — the transport choice, the lazy chunk, the pill.
 */
test.use({ browserName: "firefox" });

const GALLERY = "/preview/components";

/** The gallery's standalone `MediaPlayer` fixture — `postId="post-video-1"`. */
const PLAYER_POST_ID = "post-video-1";

/**
 * A well-formed Mux HLS URL whose token is nonsense — the manifest GET fails, which is a
 * FATAL hls.js error and therefore the exact state under test.
 */
const DEAD_PLAYBACK_URL =
  "https://stream.mux.com/eng1056-dead-fixture.m3u8?token=eng1056.not.a.real.token";

test("this browser does NOT play HLS natively — the premise the whole fix rests on", async ({
  page,
}) => {
  await page.goto(GALLERY);
  const support = await page.evaluate(() =>
    document.createElement("video").canPlayType("application/vnd.apple.mpegurl"),
  );
  // If this ever becomes "maybe"/"probably", this file has silently stopped testing the
  // bug and the assertions below would pass for the wrong reason.
  expect(support).toBe("");
});

test("hls.js carries the stream, and a dead one shows the pill instead of a black box", async ({
  page,
}) => {
  await page.route(`**/api/posts/${PLAYER_POST_ID}/playback**`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
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
  //  - `chunks` — every JS chunk the page pulls. Chunk FILENAMES are opaque hashes in a
  //    Next build (there is no "hls" in them), so lazy-loading is proved by a NEW chunk
  //    arriving at click time, not by matching a name.
  //  - `manifestFetches` — the GET for the `.m3u8`, but only those issued as
  //    `xhr`/`fetch`. This is what actually proves hls.js is the transport: a bare
  //    `<video src="…m3u8">` also requests the manifest, but the ELEMENT requests it as
  //    `media`/`other`. hls.js uses XHR.
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

  await page.goto(GALLERY);

  // The standalone player sits under its own heading; every other card on the gallery
  // also has a `.post-media-web`, so anchor on the heading rather than an ordinal.
  const media = page
    .locator("h2", { hasText: "Media player (video, standalone)" })
    .locator("xpath=following-sibling::div[1]")
    .locator(".post-media-web");
  await expect(media).toBeVisible();
  const play = media.getByRole("button", { name: "Play video" });
  await expect(play).toBeVisible();

  // Idle: play affordance only. No <video>, and nothing streamed.
  await expect(media.locator("video")).toHaveCount(0);
  expect(manifestFetches).toEqual([]);
  const chunksBeforePlay = new Set(chunks);
  await media.scrollIntoViewIfNeeded();
  await media.screenshot({ path: ".rx/review/eng-1056-01-idle.png" });

  await play.click();

  // hls.js is the transport: the manifest arrives as an XHR from the library, in a
  // browser that cannot play HLS natively at all (pinned by the test above). This also
  // proves the pre-Play assertion was not vacuous.
  await expect
    .poll(() => manifestFetches.length, {
      message: "hls.js never XHR'd the manifest — the transport did not run",
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

  // The stream is dead, so the fatal hls.js error must produce the pill AND take the
  // <video> out of the DOM. Before this ticket the element stayed, forever black.
  await expect(media.getByText("Couldn’t load video")).toBeVisible({ timeout: 30_000 });
  await expect(media.locator("video")).toHaveCount(0);
  await media.screenshot({ path: ".rx/review/eng-1056-02-transport-error.png" });
});
