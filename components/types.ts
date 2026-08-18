// Shared prop types for the member components (W4). These are view models — the
// consuming screens (W6/W7) map the BFF/PostgREST payloads onto them; components
// never fetch. `ReactionEmoji` matches the backend `reaction.emoji` CHECK set.
export type ReactionEmoji = "like" | "love" | "clap" | "pray" | "fire" | "flex" | "horse";

export interface PostMedia {
  type: "video" | "photo" | "text" | "voice" | "news";
  posterUrl?: string | null; // image, or a video poster frame
  duration?: string | null; // "0:47" (video)
  /**
   * `post.aspect_ratio`, raw. Null means unknown, which is every photo and
   * every pre-backfill video. Not clamped here: `resolveAspect` (post-card)
   * owns that, so exactly one place decides what an unusable value becomes.
   */
  aspectRatio?: number | null;
}

export interface FeedPost {
  id: string;
  horseId: string;
  horseName: string;
  trainerName: string;
  postedAgo: string; // "2h ago"
  body?: string | null;
  media: PostMedia;
  watermarked: boolean;
  raceBadge?: { text: string; kind?: "race-day" | "result" } | null;
  count: number; // post.like_count
  reacted: ReactionEmoji | null; // the viewer's reaction, if any
  bookmarked: boolean;
}

export interface HorseSummary {
  id: string;
  name: string;
  trainerName: string;
  subtitle?: string | null; // pedigree / status line
  raceDay?: boolean;
}

export interface TrainerSummary {
  id: string;
  name: string;
  horseCount: number;
}

export interface RaceDayEntry {
  horseId: string;
  horseName: string;
  info: string; // "Randwick R5 · BM78 · 1400m"
  when: string; // "Today · 4:35pm · in 6 hours"
  notify?: boolean;
}
