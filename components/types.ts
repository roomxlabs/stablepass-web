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
  /**
   * Public `trainer.website_url` — Shares Contact-trainer CTA only (ENG-831).
   * Never owner/vendor PII; never a price. Optional on every other surface.
   */
  websiteUrl?: string | null;
  /**
   * `horse.photo_url`, ALREADY SIGNED — the head avatar's photo (ENG-958).
   *
   * A SIGNED url, never the stored value: `photo_url` holds a bare object path
   * in a PRIVATE bucket, and rendering a bare path into `<img
   * src>` resolves it against the current page and silently returns HTML. The
   * (NB: `lib/storage/photos.ts` cites "guardrail #8" for this rule, but #8 in
   * `.rx/guardrails.md` is "No betting / bookmaker anything" — the private-bucket
   * rule is real and enforced in code, it is simply not one of the numbered
   * entries. Don't go looking for it there.)
   * screens mint it in their existing batched `signPhotoMap` read and hand the
   * result here; the card never signs and never fetches.
   *
   * Optional, and null-safe by design: a screen that has not resolved photos
   * gets the monogram the card has always drawn, not a broken image.
   */
  horsePhotoUrl?: string | null;
  /**
   * `trainer.photo_url`, ALREADY SIGNED — the head avatar on a STABLE UPDATE
   * card (which is the stable's voice) and the panel footer's disc. Same
   * signing rule and same fallback as `horsePhotoUrl` above.
   */
  trainerPhotoUrl?: string | null;
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
   * How many slides this post carries, from the batch mint's `slideCount`
   * (ENG-809 / ENG-815). 1 — or absent, on a surface that resolved no count —
   * is a single-photo post and draws no carousel, which is every legacy post
   * since ENG-740 ships no backfill.
   *
   * IT IS A COUNT, NOT AN ARRAY OF PHOTOS, and that is the point: it arrives in
   * the same response as slide 0, so the dots and the `n/m` chip are correct
   * before any further slide has been minted. ENG-762 carried a resolved
   * `PostPhoto[]` here instead, which meant a client island had to read and sign
   * every slide up front — the path ENG-800 revoked.
   *
   * The be derives it as HIGHEST `sort_order` + 1, not a row count, so it is an
   * upper bound: a non-contiguous `{0, 2}` reports 3 and index 1 mints to
   * nothing. The carousel draws that as a blank slide, which is a gap rather
   * than the silently-dropped photo a row count would produce.
   */
  slideCount?: number;
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
