"use client";

// Dev preview of the W4 shared components (fake data); not linked in the nav.
// Static, no-auth gallery so the shared feed/card components (which have no
// screen of their own yet — W6/W7 wire them to real data) can be reviewed and
// screenshotted. Every callback below is a no-op. Client component because the
// no-op callbacks below are functions, which can't cross the server/client
// boundary as props into the (client) PostCard/ReactionBar/HorseCard.
import { PostCard } from "@/components/post-card";
import { ReactionBar } from "@/components/reaction-bar";
import { RaceDayBand } from "@/components/race-day-band";
import { TrainerCard } from "@/components/trainer-card";
import { HorseCard } from "@/components/horse-card";
import { MediaPlayer } from "@/components/media-player";
import type { FeedPost, HorseSummary, RaceDayEntry, TrainerSummary } from "@/components/types";

const noop = () => {};

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

const VIDEO_POST: FeedPost = {
  id: "post-video-1",
  horseId: "horse-1",
  horseName: "Mahogany",
  trainerName: "Chris Waller",
  postedAgo: "2h ago",
  label: null,
  body: "Trackwork this morning at Rosehill — feeling sharp ahead of Saturday.",
  media: { type: "video", posterUrl: null, duration: "0:47" },
  watermarked: true,
  raceBadge: { text: "Race day · today 4:35pm", kind: "race-day" },
  count: 128,
  reacted: "fire",
  bookmarked: false,
};

const PHOTO_POST: FeedPost = {
  id: "post-photo-1",
  horseId: "horse-2",
  horseName: "Winx",
  trainerName: "Chris Waller",
  postedAgo: "1d ago",
  label: null,
  body: "Recovery day in the paddock.",
  media: { type: "photo", posterUrl: null },
  watermarked: false,
  raceBadge: null,
  count: 342,
  reacted: null,
  bookmarked: true,
};

// ENG-613 (round 5). The gallery previewed only the two pre-round-5 cards, so it
// was stale for the card it exists to review. These two cover the parity rows the
// live feed screens cannot show locally: the LOCAL Supabase edge runtime serves a
// `feed` STUB that returns no rows, so Explore and Following render their empty
// state here and neither can evidence the Follow pill.
const UPDATE_POST: FeedPost = {
  id: "post-text-1",
  horseId: "horse-1",
  horseName: "Mahogany",
  trainerName: "Tom Alcott",
  trainerId: "trainer-2",
  stableName: "Tom Alcott Racing",
  stableLocation: "Sydney",
  postedAgo: "1h ago",
  label: null,
  title: "Where the team is up to",
  body:
    "Quiet week here and that is exactly how we want it going into Saturday. Cando has come through his gallop well and will have one more piece of work Thursday morning.\n\n" +
    "Banjo's Girl trials Tuesday at Rosehill. She has done everything right at home so we are keen to see how she handles the day.",
  media: { type: "text", posterUrl: null },
  watermarked: false,
  raceBadge: null,
  count: 64,
  reacted: "love",
  bookmarked: true,
};

// The Follow pill only appears where the viewer does NOT follow the trainer.
const UNFOLLOWED_POST: FeedPost = {
  ...PHOTO_POST,
  id: "post-photo-2",
  // Watermarked ON PURPOSE. The pill's `z-index: 3` exists only because the
  // watermark overlay takes `z-index: 2`, so a fixture without the overlay
  // never exercises the one deviation from the design source.
  watermarked: true,
  horseName: "Black Caviar",
  trainerName: "Peter Moody",
  trainerId: "trainer-3",
  postedAgo: "3h ago",
  body: "Big run from the back of the field — second by a head.",
  reacted: null,
  bookmarked: false,
};

const RACES: RaceDayEntry[] = [
  { horseId: "horse-1", horseName: "Mahogany", info: "Randwick R5 · BM78 · 1400m", when: "Today · 4:35pm · in 6 hours", notify: true },
  { horseId: "horse-3", horseName: "Northern Star", info: "Caulfield R3 · Maiden · 1100m", when: "Today · 2:10pm · in 3 hours" },
];

const TRAINERS: TrainerSummary[] = [
  { id: "t1", name: "Chris Waller", horseCount: 3 },
  { id: "t2", name: "Peter Moody", horseCount: 1 },
];

const HORSES: HorseSummary[] = [
  { id: "horse-1", name: "Mahogany", trainerName: "Chris Waller", raceDay: true },
  { id: "horse-2", name: "Winx", trainerName: "Chris Waller" },
  { id: "horse-3", name: "Black Caviar", trainerName: "Peter Moody" },
];

// ROUND 6 / ENG-761 fixtures. The gallery is the only place the shared card can
// be seen with real styles: the local `feed` edge function is a stub, so
// /explore and /following render an empty state and cannot evidence a card
// (.rx/gotchas.md). These four cover the states the ticket names.
const LABELLED_POST: FeedPost = {
  ...PHOTO_POST,
  id: "post-labelled-1",
  horseName: "Cannonbrook",
  label: "Trackwork",
  body: "Sharp gallop on the course proper this morning.",
};

// Label + a caption long enough to need the clamp: the two must coexist.
const LABELLED_LONG_POST: FeedPost = {
  ...PHOTO_POST,
  id: "post-labelled-2",
  horseName: "Coastal Breeze (NZ)",
  label: "Post Race Report",
  body:
    "A strong run to the line for third, beaten under a length after being held up for a clear crack at them on the turn. He pulled up well, ate up overnight and has come through it in good order, so we will give him a quiet week and look at the mile at Randwick a fortnight from now rather than backing him up on Saturday.",
};

// The 2-line-exact edge case: long enough to fill two lines, short enough that
// nothing is hidden — so NO "more" should appear next to it.
const TWO_LINE_POST: FeedPost = {
  ...PHOTO_POST,
  id: "post-labelled-3",
  horseName: "Verry Elleegant (NZ)",
  label: "Race Day · Today",
  body: "Jumps from barrier four in the fourth at Flemington this afternoon, and the ground has come up a genuine good four.",
};

// Null label — the pre-round-6 default, and the majority of real posts. Draws
// no pill at all.
const UNLABELLED_POST: FeedPost = {
  ...VIDEO_POST,
  id: "post-unlabelled-1",
  label: null,
  raceBadge: null,
};

// ROUND 6 / ENG-762 fixtures — the multi-photo carousel.
//
// The slides are generated SVGs rather than real photographs, and deliberately
// so: the thing under review here is whether the dots and the n/m chip stay
// LEGIBLE over whatever the stable uploads. Three grounds — near-black, cream,
// and brand green — cover the range, and the green one is the hostile case that
// the active dot's white rim exists for. A single pretty horse photo would
// prove less.
const slide = (bg: string, fg: string, n: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">` +
      `<rect width="640" height="400" fill="${bg}"/>` +
      `<text x="320" y="220" font-family="Inter, sans-serif" font-size="64" font-weight="600" ` +
      `fill="${fg}" text-anchor="middle">PHOTO ${n}</text></svg>`,
  )}`;

const CAROUSEL_SLIDES = [
  slide("#1A1A1A", "#FAF7F2", 1),
  slide("#F1ECE3", "#1A1A1A", 2),
  slide("#285D50", "#FAF7F2", 3),
];

/**
 * ENG-815 — A STUBBED MINT, FOR THIS DEV PAGE ONLY.
 *
 * The carousel no longer receives resolved photos as a prop: it takes a post id
 * and a slide count and asks `POST /api/posts/media` for slides 1+ by index.
 * That is the whole point of the change, and it is also what a no-auth fixture
 * gallery cannot satisfy — the real route 401s here, so every slide past 0 would
 * draw blank ground and this page would stop showing what it exists to show
 * (whether the dots and the n/m chip stay legible over a hostile photo).
 *
 * So the request is answered locally, with the same generated SVGs the fixtures
 * always used. Three things keep this honest:
 *   - it is installed only when this module is evaluated, i.e. only on
 *     `/preview/components`, which is a dev aid and is not linked in the nav;
 *   - it intercepts ONLY this route and only for the fixture post ids below,
 *     delegating everything else to the real `fetch`;
 *   - it answers in the be's exact response shape, INCLUDING `mediaUrl: null`
 *     for a slide that cannot be resolved — which is what the degraded fixture
 *     below now uses instead of a hand-placed `{ url: null }`.
 *
 * As ever, this gallery is NOT evidence for the read path (it bypasses both the
 * projection and the mapper — see .rx/gotchas.md). `e2e/eng-762-photo-carousel`
 * drives the real one against local Postgres and Storage.
 */
const FIXTURE_SLIDES: Record<string, (index: number) => string | null> = {
  "post-carousel-1": (i) => CAROUSEL_SLIDES[i] ?? null,
  // The middle slide cannot be resolved: it draws the media ground while its
  // siblings still render. A dead slide must never take the whole post down.
  "post-carousel-degraded": (i) => (i === 1 ? null : CAROUSEL_SLIDES[i] ?? null),
  "post-carousel-ten": (i) =>
    slide(i % 2 ? "#F1ECE3" : "#1A1A1A", i % 2 ? "#1A1A1A" : "#FAF7F2", i + 1),
};

// The `NODE_ENV` guard is belt-and-braces: this module is only evaluated on
// `/preview/components`, which is unlinked and a dev aid. It is here because the
// patch is never removed once installed, so it would survive a client-side
// navigation off this route in a production build.
if (
  process.env.NODE_ENV !== "production" &&
  typeof window !== "undefined" &&
  !("__previewMint" in window)
) {
  (window as unknown as Record<string, unknown>).__previewMint = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "/api/posts/media" && init?.body) {
      const body = JSON.parse(String(init.body)) as { postId?: string; slideIndex?: number };
      const resolve = body.postId ? FIXTURE_SLIDES[body.postId] : undefined;
      if (resolve && typeof body.slideIndex === "number") {
        return new Response(
          JSON.stringify({
            data: {
              postId: body.postId,
              slideIndex: body.slideIndex,
              mediaUrl: resolve(body.slideIndex),
              expiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
    }
    return realFetch(input, init);
  }) as typeof window.fetch;
}

const CAROUSEL_POST: FeedPost = {
  ...PHOTO_POST,
  id: "post-carousel-1",
  horseName: "Cannonbrook",
  label: "Trackwork",
  body: "Three from the course proper this morning.",
  // `posterUrl` is slide 0, exactly as the batch delivers it on a real screen.
  media: { type: "photo", posterUrl: CAROUSEL_SLIDES[0] },
  slideCount: 3,
};

// One photo is the SAME rendering case as none: post.media_url already mirrors
// sort_order 0, and the be reports `slideCount: 1` either way, so this must draw
// the plain chip and no dots at all.
const SINGLE_PHOTO_POST: FeedPost = {
  ...PHOTO_POST,
  id: "post-carousel-single",
  horseName: "Verry Elleegant (NZ)",
  body: "One photo — no dots, no count.",
  media: { type: "photo", posterUrl: CAROUSEL_SLIDES[1] },
  slideCount: 1,
};

// A photo that cannot be resolved takes the media ground; its siblings still
// render. TWO slides, not three, so exactly ONE empty slide is on screen at
// mount — with three, slide 2 would also be blank simply because the carousel
// prefetches only one ahead, and the evidence would no longer isolate the
// degraded case from the not-yet-minted one.
const DEGRADED_CAROUSEL_POST: FeedPost = {
  ...PHOTO_POST,
  id: "post-carousel-degraded",
  horseName: "Black Caviar",
  body: "The second photo could not be resolved.",
  media: { type: "photo", posterUrl: CAROUSEL_SLIDES[0] },
  slideCount: 2,
};

// The contract's cap. Ten dots must still fit the narrow card, and they are
// drawn from `slideCount` alone — none of slides 2..9 has been minted yet.
const TEN_PHOTO_POST: FeedPost = {
  ...PHOTO_POST,
  id: "post-carousel-ten",
  horseName: "Northern Star",
  body: "Ten is the maximum the schema allows.",
  media: { type: "photo", posterUrl: CAROUSEL_SLIDES[0] },
  slideCount: 10,
};

export default function ComponentPreviewPage() {
  return (
    <div className="page-pad">
      <h1>W4 shared component preview</h1>
      <p style={{ color: "var(--muted)", marginBottom: 32 }}>
        Fake data only — a dev aid for reviewing the shared member components, not a real screen.
      </p>

      <h2>Post cards</h2>
      <div style={{ maxWidth: 520, marginBottom: 40 }}>
        <PostCard post={VIDEO_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} />
        <PostCard post={PHOTO_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} />
      </div>

      <h2 id="round6">Round 6 — label pill, caption clamp, photo chip (ENG-761)</h2>
      <p style={{ color: "var(--muted)", marginBottom: 16 }}>
        The pill draws <code>post.label</code> (one of the be&rsquo;s 13 presets) and nothing when it is
        null. Captions clamp to two lines with a &ldquo;more&rdquo; that expands in place; a caption that
        already fits gets no &ldquo;more&rdquo;. Photo posts carry the glyph chip in the duration chip&rsquo;s corner.
      </p>
      <div style={{ maxWidth: 520, marginBottom: 40 }} data-testid="round6-gallery">
        <PostCard post={LABELLED_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} />
        <PostCard post={LABELLED_LONG_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} />
        <PostCard post={TWO_LINE_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} />
        <PostCard post={UNLABELLED_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} />
      </div>

      <h2 id="round6-carousel">Round 6 — multi-photo carousel (ENG-762)</h2>
      <p style={{ color: "var(--muted)", marginBottom: 16 }}>
        A <code>slideCount</code> above one turns the media box into a scroll-snap carousel: dots
        bottom-centre, and the ENG-761 photo chip extended with an <code>n/m</code> count. One photo —
        or none, which is the same case, since <code>post.media_url</code> mirrors row 0 — draws neither.
        Drag, swipe or press a dot to page. The dots come from the count, so they are right before any
        slide past the first has been minted; slides arrive one ahead of where you are (ENG-815).
      </p>
      <div style={{ maxWidth: 520, marginBottom: 40 }} data-testid="round6-carousel-gallery">
        <PostCard post={CAROUSEL_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} />
        <PostCard post={SINGLE_PHOTO_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} />
        <PostCard post={DEGRADED_CAROUSEL_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} />
        <PostCard post={TEN_PHOTO_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} />
      </div>

      <h2>Stable update card (post.type = text | news)</h2>
      <div style={{ maxWidth: 520, marginBottom: 40 }}>
        <PostCard post={UPDATE_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} />
      </div>

      <h2>Follow pill (viewer does not follow this trainer)</h2>
      <div style={{ maxWidth: 520, marginBottom: 40 }}>
        <PostCard post={UNFOLLOWED_POST} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} onPlay={noop} canFollow onFollow={noop} />
      </div>

      <h2>Reaction bar (standalone)</h2>
      <div style={{ maxWidth: 520, border: "1px solid var(--line)", borderRadius: "var(--radius-md)", marginBottom: 40 }}>
        <ReactionBar count={12} reacted="love" bookmarked={false} onReact={noop} onBookmark={noop} />
      </div>

      <h2>Media player (video, standalone)</h2>
      <div style={{ maxWidth: 520, marginBottom: 40 }}>
        <MediaPlayer postId="post-video-1" posterUrl={null} duration="1:12" />
      </div>

      <h2>Race day band</h2>
      <div style={{ maxWidth: 340, marginBottom: 40 }}>
        <RaceDayBand races={RACES} />
      </div>

      <h2>Trainer cards</h2>
      <div style={{ maxWidth: 340, display: "flex", flexDirection: "column", gap: 12, marginBottom: 40 }}>
        {TRAINERS.map((t) => (
          <TrainerCard key={t.id} trainer={t} />
        ))}
      </div>

      <h2>Horse cards</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 200px)", gap: 18 }}>
        {HORSES.map((h) => (
          <HorseCard key={h.id} horse={h} onClick={noop} />
        ))}
      </div>
    </div>
  );
}
