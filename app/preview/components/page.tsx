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
