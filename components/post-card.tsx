"use client";

// post-card — the shared feed/profile post: head (horse/trainer byline + optional
// race badge), media (photo, or a video with a play button), the watermark overlay
// when `watermarked`, body, and the reaction bar. Presentational + callback-driven;
// it never fetches (the consumer supplies data + wires reactions/bookmark/play).
import { ReactionBar } from "./reaction-bar";
import { PostOverlay } from "./post-overlay";
import type { FeedPost, ReactionEmoji } from "./types";

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
  mediaAspect?: "wide" | "tall" | "square";
}

export function PostCard({ post, viewerId, onReact, onBookmark, onPlay, mediaAspect = "wide" }: PostCardProps) {
  const initial = post.horseName[0]?.toUpperCase() ?? "?";
  const isVideo = post.media.type === "video";
  const hasMedia = post.media.type === "video" || post.media.type === "photo";
  const aspect = mediaAspect === "tall" ? " tall" : mediaAspect === "square" ? " square" : "";

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
        <div className={`post-media-web${aspect}`}>
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
