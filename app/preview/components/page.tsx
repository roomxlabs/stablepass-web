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
