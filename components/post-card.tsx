"use client";

// post-card — the shared feed/profile post: head (horse/trainer byline + optional
// race badge), media (photo, or a video with a play button), the watermark overlay
// when `watermarked`, body, and the reaction bar. Presentational + callback-driven;
// it never fetches (the consumer supplies data + wires reactions/bookmark/play).
import type { CSSProperties } from "react";
import { ReactionBar } from "./reaction-bar";
import { PostOverlay } from "./post-overlay";
import { FollowPill } from "./follow-pill";
import type { FeedPost, PostMedia, ReactionEmoji } from "./types";

/**
 * The two post types that get the STABLE UPDATE treatment — pill, title and the
 * inset panel that stands in for the media box. Identical to mobile's M4 table:
 * `photo`, `video` and `voice` render a bare headline above their existing
 * content instead. The badge copy below is COPY, not data: nothing in the
 * payload names the card.
 */
const UPDATE_TYPES = ["text", "news"] as const;

function isUpdateType(type: PostMedia["type"]): boolean {
  return (UPDATE_TYPES as readonly string[]).includes(type);
}

/** `Stable update` for `text`, `News` for `news`. Copy, not data. */
export function badgeLabel(type: PostMedia["type"]): string {
  return type === "news" ? "News" : "Stable update";
}

/**
 * The panel renders the admin-authored post body as paragraphs, splitting on
 * blank lines exactly as the design source draws it (three <p> in the mockup).
 *
 * This is post COPY, never a comment thread — there are no comments anywhere in
 * this product, and each paragraph is one author's words, not one person's reply.
 */
export function bodyParagraphs(body: string | null | undefined): string[] {
  if (!body) return [];
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

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
  /**
   * Whether to offer the Follow pill on this card's media. The SCREEN decides,
   * from a single screen-level read of the viewer's follows — never a per-card
   * read. False (the default) is what suppresses the pill on a trainer's own
   * profile feed, where offering "Follow" on the page you are already reading is
   * noise, and on the surfaces that hold no follow state at all.
   *
   * There is no "Following" variant: a followed trainer simply gets no pill.
   */
  canFollow?: boolean;
  onFollow?: () => void;
}

export function PostCard({ post, viewerId, onReact, onBookmark, onPlay, canFollow = false, onFollow }: PostCardProps) {
  const isVideo = post.media.type === "video";
  const hasMedia = post.media.type === "video" || post.media.type === "photo";
  // text / news get the STABLE UPDATE anatomy: pill, title, the inset panel in
  // place of the media box, and the horse carried in the byline.
  const isUpdate = isUpdateType(post.media.type);
  // An update card's body IS the panel, so it is never also a caption. Empty or
  // whitespace-only means no panel at all (defensive: A2 makes body required
  // going forward).
  const paragraphs = isUpdate ? bodyParagraphs(post.body) : [];
  const showPanel = isUpdate && paragraphs.length > 0;
  const stableLine = [post.stableName, post.stableLocation].filter(Boolean).join(" · ");
  // `?.` is load-bearing. This now runs for EVERY card type, not just update
  // cards, and PostCard is a shared exported component: an undefined
  // `trainerName` slipping past an untyped `sb` payload would throw here and
  // take the whole feed down, not just this card. Every current call site
  // coalesces, so this is defence, not a live bug.
  const trainerInitial = post.trainerName?.[0]?.toUpperCase() ?? "?";
  // An update card is the STABLE's voice, so it leads with the trainer's initial;
  // a media card is about the horse and leads with the horse's.
  const initial = isUpdate ? trainerInitial : post.horseName?.[0]?.toUpperCase() ?? "?";
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
          {isUpdate ? (
            <span className="post-badge">{badgeLabel(post.media.type)}</span>
          ) : (
            <h3 className="post-horse">{post.horseName}</h3>
          )}
          {/* Exactly ONE heading per card, which is what the design source draws:
              a media card is headed by the horse (06-explore.html:84,142,167) and
              an update card by its title (:115-116) — never both. A media post
              that also carries a title would otherwise emit two sibling <h3>s in
              inverted visual hierarchy (17px/500 name above a 22px/600 title), a
              state the source never shows. So the title is a heading only when it
              IS the card's heading. */}
          {post.title &&
            (isUpdate ? (
              <h3 className="post-title">{post.title}</h3>
            ) : (
              <p className="post-title">{post.title}</p>
            ))}
          {/* The horse stays in the byline of an update card for the same reason
              as mobile's M4: `post.horse_id` is NOT NULL, and trainer → horse →
              post is the product's spine. The website sample drops it; we
              deliberately do not. A media card already leads with the horse. */}
          <div className="post-byline">
            by <span className="by-trainer">{post.trainerName}</span>
            {isUpdate && <> · {post.horseName}</>} · {post.postedAgo}
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
          {canFollow && <FollowPill trainerName={post.trainerName} onFollow={onFollow} />}
        </div>
      )}

      {showPanel && (
        <div className="post-panel">
          {paragraphs.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
          {stableLine && (
            <div className="post-panel-foot">
              <div className="av" aria-hidden="true">{trainerInitial}</div>
              <span>{stableLine}</span>
            </div>
          )}
        </div>
      )}

      <ReactionBar
        count={post.count}
        reacted={post.reacted}
        bookmarked={post.bookmarked}
        onReact={onReact}
        onBookmark={onBookmark}
      />

      {/* The caption renders LAST in the DOM and is placed below the reaction bar
          by `order` in globals.css — Instagram's ordering, decided 5 Aug. An
          update card has no caption: its body IS the panel above. */}
      {!isUpdate && post.body && <div className="post-body-web">{post.body}</div>}
    </article>
  );
}
