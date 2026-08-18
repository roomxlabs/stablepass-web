"use client";

// post-card — the shared feed/profile post: head (horse/trainer byline + optional
// race badge), media (photo, or a video with a play button), the watermark overlay
// when `watermarked`, body, and the reaction bar. Presentational + callback-driven;
// it never fetches (the consumer supplies data + wires reactions/bookmark/play).
import type { CSSProperties } from "react";
import { ReactionBar } from "./reaction-bar";
import { PostOverlay } from "./post-overlay";
import type { FeedPost, ReactionEmoji } from "./types";

/** 4:5 — the tallest box we will draw. A 9:16 reel is cropped to this. */
export const ASPECT_MIN = 0.8;
/** 1.91:1 — the widest box we will draw. */
export const ASPECT_MAX = 1.91;
/**
 * 16:10 — the box for an asset whose ratio we do not know. That is every PHOTO
 * by construction (Supabase Storage assets have no Mux `aspect_ratio`) and every
 * pre-backfill video, so it is the common case, not the exception.
 *
 * These three numbers are restated in full here rather than imported from a
 * shared package: mobile, admin and web are separate codebases, and a "see the
 * other repo" reference is exactly how they drift.
 */
export const ASPECT_DEFAULT = 1.6;

/**
 * Total by construction. The value arrives off the wire from an untyped `sb`
 * client, where `post.aspect_ratio` is a nullable Postgres `numeric` that may
 * also be absent entirely on a pre-migration payload.
 *
 * `Number.isFinite` is required, not belt-and-braces: `'NaN'::numeric` is legal
 * in Postgres AND passes the be's `CHECK (aspect_ratio > 0)` (`'NaN' > 0` is
 * TRUE there), so the column's own constraint does not guarantee a usable
 * number. It also rejects a non-number that slipped past the untyped client,
 * since `Number.isFinite` — unlike the global `isFinite` — does not coerce.
 */
export function resolveAspect(ratio: number | null | undefined): number {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) return ASPECT_DEFAULT;
  return Math.min(ASPECT_MAX, Math.max(ASPECT_MIN, ratio));
}

/**
 * The bucket class stays as the CSS fallback so the box is never zero-height
 * before the inline value applies. It is derived from the resolved ratio rather
 * than passed in by a call site, which is why no screen hardcodes an aspect any
 * more. Thresholds are the midpoints between the three bucket ratios the
 * stylesheet defines: 4/5 (0.8), 1/1 (1.0) and the base 16/9 (1.778).
 */
export function aspectBucket(aspect: number): "wide" | "tall" | "square" {
  if (aspect < 0.9) return "tall";
  if (aspect < 1.39) return "square";
  return "wide";
}

/**
 * The single source of geometry for a post media box. Every surface that draws
 * one — this card and the five inline players in `app/(member)/**` — spreads
 * this, so the box, the poster and the playing video all agree on one ratio.
 * `wide` is the stylesheet's base rule and therefore has no modifier class.
 */
export function mediaBoxProps(ratio: number | null | undefined): {
  className: string;
  style: CSSProperties;
} {
  const aspect = resolveAspect(ratio);
  const bucket = aspectBucket(aspect);
  return {
    className: bucket === "wide" ? "post-media-web" : `post-media-web ${bucket}`,
    style: { aspectRatio: String(aspect) },
  };
}

const Play = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8Z" fill="currentColor" stroke="none" /></svg>
);
const More = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export interface PostCardProps {
  post: FeedPost;
  viewerId: string; // signed-in user id — for the watermark overlay
  onReact: (emoji: ReactionEmoji) => void;
  onBookmark: () => void;
  onPlay?: () => void; // consumer mints the signed URL via the media-player
}

export function PostCard({ post, viewerId, onReact, onBookmark, onPlay }: PostCardProps) {
  const initial = post.horseName[0]?.toUpperCase() ?? "?";
  const isVideo = post.media.type === "video";
  const hasMedia = post.media.type === "video" || post.media.type === "photo";
  // The box takes the asset's OWN ratio, clamped. There is no `mediaAspect`
  // prop any more: a call site cannot hardcode a shape the asset does not have.
  const mediaBox = mediaBoxProps(post.media.aspectRatio);

  return (
    <article className="post-web">
      <div className="post-head-web">
        <div className="post-avatar-web" aria-hidden="true">{initial}</div>
        <div className="post-meta-web">
          {post.raceBadge && (
            <div className={`race-badge${post.raceBadge.kind === "result" ? " result" : ""}`}>{post.raceBadge.text}</div>
          )}
          <h3 className="post-horse">{post.horseName}</h3>
          <div className="post-byline">
            by <span className="by-trainer">{post.trainerName}</span> · {post.postedAgo}
          </div>
        </div>
        <button className="post-more-web" type="button" aria-label="More"><More /></button>
      </div>

      {hasMedia && (
        <div {...mediaBox}>
          {post.media.posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary Storage/Mux poster URL, cover-fit
            <img src={post.media.posterUrl} alt="" />
          ) : (
            <div style={{ width: "100%", height: "100%" }} />
          )}
          {isVideo && (
            <button className="media-play" type="button" aria-label="Play video" onClick={onPlay}><Play /></button>
          )}
          {isVideo && post.media.duration && <div className="media-duration">{post.media.duration}</div>}
          {post.watermarked && <PostOverlay viewerId={viewerId} />}
        </div>
      )}

      {post.body && <div className="post-body-web">{post.body}</div>}

      <ReactionBar
        count={post.count}
        reacted={post.reacted}
        bookmarked={post.bookmarked}
        onReact={onReact}
        onBookmark={onBookmark}
      />
    </article>
  );
}
