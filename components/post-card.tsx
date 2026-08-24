"use client";

// post-card — the shared feed/profile post: head (horse/trainer byline + optional
// race badge), media (photo, or a video with a play button), the watermark overlay
// when `watermarked`, body, and the reaction bar. Presentational + callback-driven;
// it never fetches (the consumer supplies data + wires reactions/bookmark/play).
import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * The photo chip — the still-image counterpart to `.media-duration`, in the
 * same corner with the same scrim (round 6 / ENG-761 item 3). A video says how
 * long it runs; a photo has no such number, so it says what it IS with a glyph.
 * That is the whole parity: at a glance the media box always declares its type.
 */
const PhotoGlyph = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="8.5" cy="10" r="1.5" />
    <path d="m21 16-5-5L5 19" />
  </svg>
);

/**
 * The caption, clamped to two lines with a "more" affordance (round 6 / ENG-761
 * item 2, matching mobile).
 *
 * WHY A MEASUREMENT AND NOT A CHARACTER COUNT: how many lines a caption takes
 * depends on the rendered font, the column width and where the words break, so
 * any length threshold is wrong at some viewport. After layout we compare the
 * element's `scrollHeight` (its full text) against its `clientHeight` (the two
 * lines the clamp actually shows) and only offer "more" when the former
 * genuinely exceeds the latter. A caption that lands on exactly two lines
 * measures equal and gets NO affordance — the edge case the ticket calls out.
 *
 * WHY "more" EXPANDS IN PLACE rather than opening the post detail: this app has
 * no post-detail route. `app/(member)` has explore, following, saved, horses,
 * horses/[id], trainers, trainers/[id], account and checkout — there is no
 * `posts/[id]` page to open, and adding one is a screen, not a line of this
 * ticket. Expanding in place is the honest web equivalent (and is what
 * Instagram's own web feed does); if a detail route is ever built, this is the
 * one call site to repoint. Flagged on ENG-761.
 */
export function PostCaption({ body }: { body: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el || expanded) return;
    // A 1px tolerance: sub-pixel line heights make an exactly-two-line caption
    // measure a hair over on some zoom levels, which would show a "more" that
    // reveals nothing.
    setOverflows(el.scrollHeight - el.clientHeight > 1);
  }, [expanded]);

  useEffect(() => {
    measure();
    // The column is fluid, so a resize can turn a two-line caption into three.
    // Guarded because jsdom (the unit suite) has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [measure, body]);

  return (
    <div className="post-body-web">
      <div ref={ref} className={expanded ? "post-caption" : "post-caption clamped"} data-testid="post-caption">
        {body}
      </div>
      {overflows && !expanded && (
        // The visible word is "more", but the card ALREADY has a button whose
        // accessible name is "More" — the `⋯` post-options control in the head.
        // Two same-named buttons in one card is a real ambiguity for anyone
        // navigating by name (and it made the first version of the e2e spec
        // match five controls where one was meant). The label disambiguates
        // without changing what a sighted reader sees.
        <button
          type="button"
          className="post-caption-more"
          aria-label="Expand caption"
          onClick={() => setExpanded(true)}
        >
          more
        </button>
      )}
    </div>
  );
}

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
          {/* The `.post-badge` pill RETURNS in round 6 (ENG-761), but as DATA
              rather than the card-type copy it used to be: it draws
              `post.label`, one of the be's 13 presets (ENG-738), and nothing
              at all when the column is null — which is every pre-round-6 post.
              The 18 Aug retirement stands for the old derived-copy pill; the
              horse name still heads every card variant beneath it. */}
          {post.label && <span className="post-badge">{post.label}</span>}
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
          {post.media.posterUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- arbitrary Storage/Mux poster URL, cover-fit
            <img src={post.media.posterUrl} alt="" />
          ) : (
            <div style={{ width: "100%", height: "100%" }} />
          )}
          {isReel && (
            /* THE REEL HEADER — the card's identity on a top scrim, with the
               Follow pill IN the row next to the name (mobile's 18 Aug
               placement: aligned and legible, ENG-606's pill untouched). */
            <div className="reel-head">
              <div className="post-avatar-web" aria-hidden="true">{initial}</div>
              <div className="reel-head-meta">
                {/* The pill draws on EVERY web card variant, reel included —
                    web has no separate reel treatment for it this round. */}
                {post.label && <span className="post-badge">{post.label}</span>}
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
          {/* The photo's answer to the duration chip: same corner, same scrim. */}
          {post.media.type === "photo" && (
            <div className="media-photo-chip" data-testid="media-photo-chip" aria-label="Photo">
              <PhotoGlyph />
            </div>
          )}
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
      {!isUpdate && post.body && <PostCaption body={post.body} />}
    </article>
  );
}
