"use client";

// post-card — the shared feed/profile post: head (horse/trainer byline + optional
// race badge), media (photo, or a video with a play button), the watermark overlay
// when `watermarked`, body, and the reaction bar. Callback-driven: the consumer
// supplies the data and wires reactions/bookmark/play.
//
// One exception to "never fetches" (ENG-813): the media <img> is PostMediaImage,
// which on an error re-mints THAT post's signed URL once before falling back to
// the placeholder. The card still owns no page-level fetching, and the
// subscription gate still lives on the screen, not here — a re-mint that comes
// back 402 renders the placeholder, never gated bytes.
import type { CSSProperties } from "react";
import { ReactionBar } from "./reaction-bar";
import { PostOverlay } from "./post-overlay";
import { FollowPill } from "./follow-pill";
import { PostMediaImage } from "./post-media-image";
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

// The `badgeLabel` copy helper is gone with the `.post-badge` pill (Justin via
// Naufal, 18 Aug 2026): the horse-name headline heads every card variant.

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
 * 9:16 — the tallest box a REEL draws (client, 18 Aug 2026, ported from
 * mobile): a portrait VIDEO keeps its full uncropped ratio down to 9:16 and
 * takes the reel layout (header overlaid on the frame). Portrait PHOTOS keep
 * the 4:5 clamp, exactly as Instagram crops them in the home feed.
 */
export const REEL_ASPECT_MIN = 9 / 16;

/** A portrait VIDEO is a reel. Decided on the RAW ratio, before any clamp —
 * `resolveAspect` would floor a 9:16 at 4:5 and hide what makes it a reel. */
export function isReelMedia(media: PostMedia): boolean {
  return (
    media.type === "video" &&
    media.aspectRatio != null &&
    Number.isFinite(media.aspectRatio) &&
    media.aspectRatio > 0 &&
    media.aspectRatio < 1
  );
}

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
export function mediaBoxProps(
  ratio: number | null | undefined,
  opts?: { video?: boolean },
): {
  className: string;
  style: CSSProperties;
} {
  // A portrait VIDEO escapes the 4:5 clamp entirely (client, 18 Aug 2026):
  // the box takes the asset's own ratio down to 9:16, tagged `reel` so the
  // stylesheet's fallback keeps it tall before the inline value applies. The
  // five inline players in `app/(member)/**` pass `video: true`, so a playing
  // reel keeps the same tall box the card drew.
  if (
    opts?.video &&
    ratio != null &&
    Number.isFinite(ratio) &&
    ratio > 0 &&
    ratio < 1
  ) {
    return {
      className: "post-media-web reel",
      style: { aspectRatio: String(Math.max(REEL_ASPECT_MIN, ratio)) },
    };
  }
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
  // The box takes the asset's OWN ratio, clamped — except a REEL (portrait
  // video), which keeps its true ratio down to 9:16 and takes Instagram's
  // in-feed reel layout: the header overlays the top of the frame on an ink
  // scrim, while actions and caption stay BELOW the media on the card ground
  // (client, 18 Aug 2026: "it shouldnt look like 1:1 with the fullscreen").
  const isReel = isReelMedia(post.media);
  const mediaBox = mediaBoxProps(post.media.aspectRatio, { video: isVideo });

  return (
    <article className="post-web">
      {!isReel && (
      <div className="post-head-web">
        <div className="post-avatar-web" aria-hidden="true">{initial}</div>
        <div className="post-meta-web">
          {post.raceBadge && (
            <div className={`race-badge${post.raceBadge.kind === "result" ? " result" : ""}`}>{post.raceBadge.text}</div>
          )}
          {/* The `.post-badge` PILL IS RETIRED (Justin via Naufal, 18 Aug
              2026: not needed — "the header will stay the same as the
              others"). The horse heads EVERY card, update cards included,
              which also means it leaves the update byline below. */}
          <h3 className="post-horse">{post.horseName}</h3>
          {/* `post.title` is not drawn AT ALL — on any variant (client, 18
              Aug 2026, in two steps: media cards first, then the update card:
              "dont need the title. same as others"). The data still flows;
              the cards just never render it. */}
          <div className="post-byline">
            <span className="by-trainer">{post.trainerName}</span> · {post.postedAgo}
          </div>
        </div>
        <button className="post-more-web" type="button" aria-label="More"><More /></button>
      </div>
      )}

      {hasMedia && (
        <div {...mediaBox}>
          <PostMediaImage postId={post.id} src={post.media.posterUrl} video={isVideo} />
          {isReel && (
            /* THE REEL HEADER — the card's identity on a top scrim, with the
               Follow pill IN the row next to the name (mobile's 18 Aug
               placement: aligned and legible, ENG-606's pill untouched). */
            <div className="reel-head">
              <div className="post-avatar-web" aria-hidden="true">{initial}</div>
              <div className="reel-head-meta">
                <h3 className="reel-horse">{post.horseName}</h3>
                <div className="reel-byline">
                  <span className="by-trainer">{post.trainerName}</span> · {post.postedAgo}
                </div>
              </div>
              {canFollow && <FollowPill trainerName={post.trainerName} onFollow={onFollow} />}
            </div>
          )}
          {isVideo && (
            <button className="media-play" type="button" aria-label="Play video" onClick={onPlay}><Play /></button>
          )}
          {isVideo && post.media.duration && <div className="media-duration">{post.media.duration}</div>}
          {post.watermarked && <PostOverlay viewerId={viewerId} />}
          {!isReel && canFollow && <FollowPill trainerName={post.trainerName} onFollow={onFollow} />}
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
