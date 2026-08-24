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

/**
 * One row of `post_media` (ENG-740), signed. The be's table is
 * `(post_id, sort_order, media_url)` with `UNIQUE (post_id, sort_order)` and
 * `CHECK (sort_order >= 0 AND sort_order <= 9)` — so a post carries at most 10
 * photos and the order is a 0-based integer the admin controls, NOT insertion
 * or filename order. Verified against the deployed table, not the ticket prose.
 */
export interface PostPhoto {
  /**
   * The signed URL, or `null` when signing failed for THIS photo. Null is a
   * real state, not a type-level convenience: `signPhotoMap` degrades per key,
   * so one dead object must leave the other slides renderable.
   */
  url: string | null;
  /** `post_media.sort_order`, carried through so the order is the be's, not the array's. */
  sort: number;
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
  /**
   * `post.label` — one of the 13 presets the be pins with a CHECK (ENG-738), or
   * null. Drawn as the green pill at the top of the card; null means no pill,
   * which is every pre-round-6 post (the column is nullable with no backfill).
   *
   * It is COPY chosen by the admin at compose time, not a card selector: what
   * makes a card a STABLE UPDATE is still `media.type`, exactly as on mobile.
   * The two are independent — a labelled photo post is a normal photo card that
   * happens to carry a pill.
   */
  label: string | null;
  body?: string | null;
  media: PostMedia;
  /**
   * The post's `post_media` rows, signed and already ordered by `sort_order`.
   * Empty or absent for every legacy post (nothing is backfilled), which is what
   * keeps a single-photo card byte-identical to what it drew before round 6:
   * fewer than two photos and no carousel exists.
   *
   * NAMED `photos`, NOT `media` as ENG-762's prose has it — `media` is already
   * taken on this type by the `PostMedia` view model above, and the ticket was
   * written without that in hand. Flagged on the issue.
   */
  photos?: PostPhoto[];
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
