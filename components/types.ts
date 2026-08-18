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
  /**
   * `horse.trainer_id` — the post's trainer, for the Follow pill. The pill is a
   * property of WHO wrote the post, so the card needs the id, not just the name;
   * a name is not a key. Optional because two surfaces (Saved, the profile feeds)
   * do not offer the pill and so never resolve it.
   */
  trainerId?: string | null;
  /** `trainer.stable_name` — the STABLE UPDATE panel footer. Not owner identity. */
  stableName?: string | null;
  /** `trainer.location` — the other half of the panel footer. */
  stableLocation?: string | null;
  postedAgo: string; // "2h ago"
  /**
   * `post.title`. The headline, and the trigger for the title line on every card
   * type. It does NOT select the STABLE UPDATE card — `media.type` does, exactly
   * as on mobile's M4 — so a text post with no title still gets pill and panel.
   */
  title?: string | null;
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
