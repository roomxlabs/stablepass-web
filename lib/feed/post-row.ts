import { signedPosterFor } from "@/lib/storage/photos";
import type { FeedPost, PostMedia, ReactionEmoji } from "@/components/types";

/**
 * post-row — the ONE place a `post` column becomes a card field (ENG-794).
 *
 * WHY THIS EXISTS. Three tickets in a row shipped a `post` column that reached
 * the BFF and was then silently dropped one layer later: ENG-761 (the label
 * pill), ENG-772 (the profile-feed projections), ENG-775 (the saved mapper).
 * Every one of the three was a POST-INTRINSIC field, and every one was found by
 * eye rather than by a gate, because five member screens each kept their own row
 * type and their own hand-copied mapper.
 *
 * ENG-785 made a dropped mapper line a COMPILE error by making `FeedPost.label`
 * required. That catches the next one, but only for the fields somebody
 * remembered to mark required, and `tsc` still cannot see a `.select()` at all
 * (`sb` is untyped — see .rx/gotchas.md). This module removes the surface the bug
 * happens on instead, and closes both halves at once: one mapper, one projection.
 *
 * WHAT IS DELIBERATELY *NOT* HERE. Only the ten fields that are identical on
 * every screen. The identity/context fields (`horseId`, `horseName`,
 * `trainerName`, `trainerId`, `stableName`, `stableLocation`, `bookmarked`) stay
 * resolved per screen, because the three non-feed screens diverge there for real,
 * measured reasons (ENG-785):
 *   - horses/[id] takes horse+trainer identity from page-level props;
 *   - trainers/[id] resolves the horse from an embedded join with a two-sided
 *     name fallback;
 *   - saved/ hardcodes `bookmarked: true` — everything there is saved by
 *     definition — and never resolves `trainerId`.
 * Forcing those together would trade a duplication bug for a coupling bug, so
 * ENG-794 scoped this to the intrinsics on purpose. Resist widening it.
 */

/**
 * The exact `post` projection every explicitly-projected feed read shares.
 *
 * Pinned as a constant for the same reason `ACCESS_COLUMNS` and
 * the be's own projection constants are: `sb` is untyped, so `tsc` can never catch a
 * too-narrow `.select()`, and this projection is load-bearing in BOTH
 * directions. Too narrow silently starves the card (that is exactly how `label`
 * went missing on both profile feeds). Too wide names a column that is not
 * deployed, which makes PostgREST reject the WHOLE query with 42703/HTTP 400 —
 * and because the routes destructure only `data`, that surfaces as a cheerful
 * empty list, not a 500. A total content blackout that looks like an empty
 * stable. Never add a column here ahead of its migration.
 *
 * `mux_playback_id` is carried because both routes have always selected it, even
 * though no mapper below reads it; it is left exactly as-is so this constant
 * reproduces the two pinned projection strings byte-for-byte.
 *
 * NOT used by `/explore` or `/following` (they proxy the be `feed` fn's
 * `setof post`, so there is no projection to share) nor by `/saved` (it reads
 * `post:post_id(*)`, a star). Whether the BFF feed routes should share it too is
 * explicitly OUT of scope for ENG-794 — answering it needs the live wire shape,
 * and locally `post.label` is undeployed and the `feed` edge function is a stub.
 */
export const POST_INTRINSIC_COLUMNS =
  "id, type, title, body, label, media_url, poster_url, mux_playback_id, aspect_ratio, watermarked, like_count, published_at";

/**
 * The `post` columns every member feed row carries. Screens intersect this with
 * their own context columns (`& { horse_id: string }`, an embedded horse join,
 * …) rather than restating the intrinsics.
 */
export type PostIntrinsicRow = {
  id: string;
  type: PostMedia["type"];
  title: string | null;
  body: string | null;
  label: string | null;
  media_url: string | null;
  poster_url: string | null;
  aspect_ratio: number | null;
  watermarked: boolean;
  like_count: number;
  published_at: string;
};

/**
 * The ten card fields that are post-intrinsic — identical on all five screens.
 * Adding a `post` column that the card renders means adding its key here, to
 * `PostIntrinsicRow`, to `postIntrinsics()` and to `POST_INTRINSIC_COLUMNS`: four
 * edits in ONE file, instead of five mappers and five row types across five.
 */
export type PostIntrinsicKey =
  | "id"
  | "postedAgo"
  | "title"
  | "body"
  | "label"
  | "media"
  | "slideCount"
  | "watermarked"
  | "count"
  | "reacted";

/**
 * `Required<...>` is load-bearing, and is strictly stronger than the ENG-785
 * trick it generalises. Several of these keys are OPTIONAL on `FeedPost`
 * (`title?`, `body?`, `slideCount?`), so a plain `Pick` would let `postIntrinsics()`
 * quietly omit one and still compile — the exact failure ENG-785 fixed for
 * `label` alone by dropping its `?`. Requiring every key here makes a forgotten
 * line a compile error for ALL ten, without forcing the view model to mark
 * fields required that genuinely are optional for its other consumers.
 */
export type PostIntrinsics = Required<Pick<FeedPost, PostIntrinsicKey>>;

/**
 * The per-page lookups the intrinsics need. All three are built ONCE per feed
 * page by the calling screen (one batched read each) and handed in — this module
 * never queries, exactly like the `components/types.ts` view models it feeds.
 *
 * `signedMedia` is a `Map` rather than a `ReadonlyMap` because `signedPosterFor`
 * takes one; the other two are read-only here.
 */
export type PostIntrinsicsContext = {
  /**
   * `post id -> minted url`, from `resolvePostDisplayUrls`. An absolute value
   * (an already-public URL) is keyed by itself instead — see `signedPosterFor`,
   * which this module calls to resolve either shape.
   */
  signedMedia: Map<string, string>;
  /**
   * `post id -> slideCount`, from the page's batch mint. Absent is the legacy
   * single-photo case.
   */
  slideCountByPost: ReadonlyMap<string, number>;
  /** `post id -> the VIEWER's own reaction`, from the batched `reaction` read. */
  reactionByPost: ReadonlyMap<string, ReactionEmoji>;
};

/**
 * "2h ago". Was defined three times independently (explore-feed, following-screen,
 * saved-feed) and imported from explore-feed by the other two — all four copies
 * byte-identical, which is the same duplication disease this module treats.
 */
export function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/**
 * Turn one `post` row into the post-intrinsic half of a `FeedPost`. Callers
 * spread the result and add their own identity/context fields:
 *
 *     { ...postIntrinsics(r, ctx), horseId: r.horse_id, horseName, bookmarked }
 *
 * Pure: no fetching, no ordering, no gate. It is a mapper, so it is safe to call
 * anywhere the caller has already decided the viewer may see the row — it can
 * never be the thing that moves a read above a content gate.
 */
export function postIntrinsics(row: PostIntrinsicRow, ctx: PostIntrinsicsContext): PostIntrinsics {
  return {
    id: row.id,
    postedAgo: relativeTime(row.published_at),
    title: row.title,
    label: row.label,
    body: row.body,
    // `aspectRatio` is RAW here. `resolveAspect` (post-card) owns the clamp, so
    // exactly one place decides what an unusable value becomes. The `typeof`
    // guard is load-bearing, not belt-and-braces: `'NaN'::numeric` passes the be's
    // `CHECK (aspect_ratio > 0)` and `to_json` serialises it as the QUOTED string
    // "NaN", which would otherwise widen a string into a field typed
    // `number | null`. (This comment used to be duplicated five times.)
    media: {
      type: row.type,
      posterUrl: signedPosterFor(row, ctx.signedMedia),
      duration: null,
      aspectRatio: typeof row.aspect_ratio === "number" ? row.aspect_ratio : null,
    },
    // `?? 1` is the legacy no-rows case, which the be also reports as
    // `slideCount: 1` (ENG-809 decision 3).
    slideCount: ctx.slideCountByPost.get(row.id) ?? 1,
    watermarked: row.watermarked,
    count: row.like_count,
    reacted: ctx.reactionByPost.get(row.id) ?? null,
  };
}
