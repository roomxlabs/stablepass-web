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
//
// A CAROUSEL widens that same exception rather than adding a second one
// (ENG-815): PhotoCarousel mints slides 1+ by index, through the same BFF route
// and the same PostMediaImage element. What the card still never does is fetch
// for the PAGE — slide 0 and the slide COUNT both arrive in the screen's batch,
// so the dots are right on first paint without this component asking anyone.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ReactionBar } from "./reaction-bar";
import { PostOverlay } from "./post-overlay";
import { FollowPill } from "./follow-pill";
import { MediaPhotoChip, PhotoCarousel } from "./photo-carousel";
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

/**
 * The photo chip moved to `photo-carousel.tsx` in round 6 (ENG-762) so the
 * single-photo card and the carousel draw the SAME chip — the multi-photo state
 * adds an `n/m` count to it, and two copies of that element would drift.
 * `MediaPhotoChip` is imported above; the ENG-761 behaviour is unchanged.
 */

/**
 * More than one slide is what makes a post a carousel — not the post type, and
 * not `media_url`. ENG-740 mirrors row 0 into `post.media_url`, so a one-slide
 * post is indistinguishable from a legacy single-photo post by design, and both
 * take the plain `<img>` path they always did.
 *
 * ENG-815 moved the source of that number from a client-side `post_media` read
 * to the batch mint's `slideCount`, so this now decides from a COUNT rather than
 * from an array of already-resolved photos. That is what lets the dots be right
 * on first paint: the old form could not call a post a carousel until every one
 * of its slides had been read and signed.
 *
 * `?? 1` is the legacy case and the majority one — no `post_media` rows at all,
 * which the be reports as `slideCount: 1` and a screen that never resolved a
 * count leaves undefined. Both mean "one photo", and one photo is not a
 * carousel.
 */
export function isCarouselPost(post: FeedPost): boolean {
  return post.media.type === "photo" && (post.slideCount ?? 1) > 1;
}

/**
 * The caption, clamped to two lines with a "more" affordance (round 6 / ENG-761
 * item 2).
 *
 * NOT "matching mobile", despite the ticket's wording: as of `feature/round6-v1`
 * mobile's post card has no caption clamp at all (no `numberOfLines` on the
 * body) and its `.post-badge` pill is still retired. Web is AHEAD here, not in
 * step. Said plainly because comments are this repo's decision record, and
 * "matching mobile" would send the next reader to "fix" mobile toward behaviour
 * it does not have.
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

    // RE-MEASURE WHEN THE WEBFONT LANDS. This is the one path that could lose
    // content: the first measurement runs against the fallback face, and if the
    // real face is wider a caption that fitted in two lines becomes three. The
    // ResizeObserver below would NOT catch it — the clamped box stays exactly
    // two lines tall, so its border box never changes and RO never fires, while
    // `scrollHeight` quietly grows past it. The result would be a truncated
    // caption with no "more" to open it. `document.fonts` is absent in jsdom
    // and in older browsers, hence the guard.
    let cancelled = false;
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(() => {
        if (!cancelled) measure();
      });
    }

    // The column is fluid, so a resize can turn a two-line caption into three.
    // Guarded because jsdom (the unit suite) has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return () => { cancelled = true; };
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
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

/**
 * THE HEAD AVATAR — a rounded BOX carrying the real photo, monogram as fallback
 * (ENG-958, porting mobile's ENG-833 + ENG-869).
 *
 * Shape: mobile went boxy on the browse rows at ENG-833 and brought the same
 * corner to the post head at ENG-869, with the client's reason recorded on the
 * mobile `AVATAR_BOX_RADIUS`: *"with circles it's going to be too difficult to
 * position the horses"* — a horse photographed side-on is a long subject and a
 * circle crops whichever end the framing did not centre. So this is a cropping
 * decision, not a taste one, and it is the same horse photo in the same product
 * as the browse thumbs. The radius lives in `.post-avatar-web` (14px, mobile's
 * `Radius.md`, the card-media radius). **The stable-update panel's footer disc
 * (`.post-panel-foot .av`) stays a CIRCLE** — it is a stable's mark, not a
 * profile photo (mobile ENG-754 draws it the same way, and pins it as a
 * control). A test pins that split so a future "round the avatars" sweep cannot
 * quietly take the footer with it.
 *
 * Photo: web drew an initial letter and nothing else until now, on every card,
 * while mobile has painted the signed photo since ENG-754. `url` is an ALREADY
 * SIGNED url — this component never mints and never fetches, exactly like the
 * rest of the card; the screens sign in their existing batch (`signPhotoMap`).
 *
 * `onError` → monogram. Not defensive padding: a revoked or rotated bucket
 * object does NOT throw, it resolves to an `<img>` that never paints (see
 * `.rx/gotchas.md`, ENG-815 — "a revoked bucket does not throw, it renders a
 * carousel of nulls"). Falling back on the error event turns that silent broken
 * -image icon back into the monogram the card had before.
 */
export function PostAvatar({
  url,
  initial,
  className = "post-avatar-web",
}: {
  url?: string | null;
  initial: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  // A NEW url deserves a fresh attempt — otherwise one dead object poisons the
  // element for every post that recycles it during a feed page change.
  //
  // React's "adjust state when a prop changes" pattern (a render-phase
  // `setState`, which React re-renders immediately without painting), NOT a
  // `useEffect`. `react-hooks/set-state-in-effect` is an ERROR in this repo, not
  // a warning (.rx/gotchas.md), and the effect form is also a frame slower: it
  // would paint the previous post's monogram before resetting.
  const [seenUrl, setSeenUrl] = useState(url);
  if (url !== seenUrl) {
    setSeenUrl(url);
    setFailed(false);
  }

  if (url && !failed) {
    return (
      // `alt=""` + aria-hidden: the horse's name is already the adjacent
      // headline, so announcing it twice is noise for a screen reader. The
      // monogram branch has always been `aria-hidden` for the same reason.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        className={`${className} post-avatar-photo`}
        src={url}
        alt=""
        aria-hidden="true"
        data-testid="post-avatar-photo"
        onError={() => setFailed(true)}
      />
    );
  }
  return <div className={className} aria-hidden="true">{initial}</div>;
}

/**
 * How many lines of the stable-update PANEL a member sees before "Read more"
 * (mobile ENG-863; Justin, 26 Aug 2026: a long update should truncate rather
 * than run the height of the screen).
 *
 * EIGHT, not the caption's two — the panel IS the post on this variant (there
 * is no media box and no second copy below the bar), so clamping it as hard as
 * a caption would leave the card saying nothing. The caption stays at 2 and is
 * untouched here.
 */
export const PANEL_CLAMP_LINES = 8;

/**
 * The 12px gap between panel paragraphs. The STYLE (`.post-panel p`'s
 * `margin-bottom`) and the clamp arithmetic below must be the SAME number: the
 * budget walks paragraphs and pays for each gap it crosses, so a one-sided drift
 * is a silently wrong clamp. Mobile names its own constant for this exact
 * reason; this is the web half.
 */
export const PANEL_PARAGRAPH_GAP = 12;

/** The affordance copy, shared by both halves of the in-place toggle. */
export const READ_MORE_LABEL = "Read more";
/**
 * The collapse half (Justin, 26 Aug 2026: "expanded text can be minimized
 * back"). Only the PANEL offers it — the caption's clamp is two lines, so
 * expanding it adds little, and there is no post-detail route on web to send a
 * member to instead.
 */
export const READ_LESS_LABEL = "Read less";

/**
 * How many lines of prose the panel carries, from each paragraph's MEASURED
 * height over the MEASURED height of one line.
 *
 * WHY MEASURED AND NOT A CONSTANT (ported from mobile's `panelLineCount`): a
 * token-derived line height is not invariant to the reader's text size or to the
 * webfont, so `8 * 23.25` fires "Read more" under an update that is not
 * truncated as soon as the page is zoomed a notch. Dividing a measured
 * paragraph height by a measured line height cancels the scale factor out.
 *
 * `Math.round`, not `Math.ceil`: a browser reports a three-line paragraph as
 * 58.5 but has been seen to report 58.500001, and `ceil` calls that four lines.
 * `Math.max(1, …)` floors a laid-out paragraph at one line so a sub-pixel height
 * can never count as zero.
 */
export function panelLineCount(paragraphHeights: readonly number[], lineHeight: number): number {
  // Nothing measured yet — 0 lines, so the panel renders UNCLAMPED on the first
  // frame rather than collapsing to nothing.
  if (lineHeight <= 0) return 0;
  let lines = 0;
  for (const height of paragraphHeights) {
    if (height > 0) lines += Math.max(1, Math.round(height / lineHeight));
  }
  return lines;
}

/**
 * The height the clamped panel may occupy to show exactly `maxLines` lines of
 * prose — THE BETWEEN-PARAGRAPH GAPS INCLUDED.
 *
 * Capping at `maxLines * lineHeight` would be wrong on the multi-paragraph
 * updates that are the common shape here: the 12px gaps would come out of that
 * budget, so a three-paragraph update would show six and a half lines of text
 * under a rule that says eight. This walks the paragraphs instead — spending the
 * line budget on real lines and paying for each gap it crosses on top — so the
 * member sees eight lines of WORDS whatever the paragraphing.
 *
 * Returns 0 when nothing has been measured; the caller reads that as "do not
 * clamp yet", never "clamp to nothing".
 */
export function panelClampHeight(
  paragraphHeights: readonly number[],
  lineHeight: number,
  gap: number = PANEL_PARAGRAPH_GAP,
  maxLines: number = PANEL_CLAMP_LINES,
): number {
  if (lineHeight <= 0 || maxLines <= 0) return 0;
  let spent = 0;
  let height = 0;
  for (const paragraphHeight of paragraphHeights) {
    if (spent >= maxLines) break;
    if (!(paragraphHeight > 0)) continue;
    const lines = Math.max(1, Math.round(paragraphHeight / lineHeight));
    const take = Math.min(lines, maxLines - spent);
    // The gap is charged only for a paragraph actually REACHED, so a budget that
    // runs out mid-way never pays for a gap the member cannot see.
    if (height > 0) height += gap;
    height += take * lineHeight;
    spent += take;
  }
  return height;
}

/**
 * THE STABLE-UPDATE PANEL, clamped to eight measured lines with an in-place
 * "Read more" / "Read less" (ENG-958, porting mobile ENG-863). Web rendered
 * every paragraph unclamped until now, so a long update ran the height of the
 * screen.
 *
 * WHY `max-height` + `overflow: hidden` AND NOT `-webkit-line-clamp`: the budget
 * is EIGHT LINES ACROSS PARAGRAPHS. A line-clamp caps ONE box, so eight on each
 * `<p>` shows twenty-four lines on a three-paragraph update; eight on the
 * wrapper collapses the paragraph gaps into the clamped flow and (per
 * `.rx/gotchas.md`, ENG-761) would swallow any affordance placed inside it.
 * Walking the measured paragraphs is the only arrangement that spends the budget
 * on real lines and charges the real gaps.
 *
 * THE TRADE, stated honestly and inherited from mobile: a `-webkit-line-clamp`
 * box gets the browser's own "…" on its last line and a clipped box does not, so
 * the ONLY truncation cue here is the "Read more" below it. That is deliberate
 * and is the SAME call as mobile's — the trailing dots were removed on 26 Aug
 * 2026 ("Read more…" reads as a sentence trailing off, i.e. as more COPY, where
 * the bare "Read more" reads as a control). The light-green medium styling is
 * what separates it from the prose now, and this ticket must not reintroduce the
 * dots on web while mobile has dropped them — that IS the parity item.
 *
 * The affordance is a SIBLING of the clamped box, never a child of it.
 */
export function PostPanel({
  paragraphs,
  stableLine,
  trainerInitial,
  trainerPhotoUrl,
}: {
  paragraphs: string[];
  stableLine: string;
  trainerInitial: string;
  trainerPhotoUrl?: string | null;
}) {
  const proseRef = useRef<HTMLDivElement | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [heights, setHeights] = useState<number[]>([]);
  const [lineHeight, setLineHeight] = useState(0);

  const measure = useCallback(() => {
    const prose = proseRef.current;
    const probe = probeRef.current;
    if (!prose || !probe) return;
    // A zero is IGNORED rather than stored: it would take the divisor to 0 and
    // switch the clamp off for the life of the card, silently.
    const probeHeight = probe.getBoundingClientRect().height;
    if (probeHeight > 0) setLineHeight(probeHeight);
    // The prose block is never itself clamped (the WRAPPER is), which is what
    // lets each paragraph report its FULL height while the member sees less.
    const next = Array.from(prose.querySelectorAll("p")).map(
      (p) => p.getBoundingClientRect().height,
    );
    setHeights((prev) =>
      prev.length === next.length && prev.every((h, i) => Math.abs(h - next[i]) < 0.5)
        ? prev // identical — returning `prev` keeps this out of a render loop
        : next,
    );
  }, []);

  useEffect(() => {
    measure();
    // RE-MEASURE WHEN THE WEBFONT LANDS — the same path `PostCaption` documents:
    // the first measurement runs against the fallback face, and a wider real
    // face turns an eight-line update into nine. `document.fonts` is absent in
    // jsdom, hence the guard.
    let cancelled = false;
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(() => { if (!cancelled) measure(); });
    }
    // The column is fluid, so a resize repaginates the prose. Guarded because
    // jsdom has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return () => { cancelled = true; };
    const ro = new ResizeObserver(measure);
    if (proseRef.current) ro.observe(proseRef.current);
    return () => { cancelled = true; ro.disconnect(); };
  }, [measure, paragraphs]);

  const needsMore = panelLineCount(heights, lineHeight) > PANEL_CLAMP_LINES;
  const clamped = needsMore && !expanded;
  const maxHeight = panelClampHeight(heights, lineHeight);

  return (
    <>
      <div className="post-panel">
        <div
          className="post-panel-clamp"
          data-testid="post-panel-clamp"
          // `maxHeight: 0` is never applied — `clamped` is false until something
          // has been measured, so an unmeasured panel renders in full rather
          // than collapsing to nothing on the first frame.
          style={clamped && maxHeight > 0 ? { maxHeight, overflow: "hidden" } : undefined}
        >
          <div className="post-panel-prose" ref={proseRef} data-testid="post-panel-prose">
            {paragraphs.map((paragraph, i) => (
              <p key={i}>{paragraph}</p>
            ))}
          </div>
        </div>
        {/* THE LINE PROBE — one line of panel prose at the size the member is
            actually reading at, so the arithmetic divides by a MEASURED number
            instead of a token (the text-size bug the helpers document). A
            non-breaking space cannot wrap, so its height is one line by
            construction. Laid out but invisible: `visibility: hidden` in a
            zero-height box, NOT `display: none` — a node that is not laid out
            has no height to report. `aria-hidden` keeps it out of the a11y
            tree. */}
        <div className="post-panel-line-probe" aria-hidden="true">
          <div ref={probeRef} data-testid="post-panel-line-probe">{" "}</div>
        </div>
        {stableLine && (
          <div className="post-panel-foot">
            {/* The footer disc stays a CIRCLE and takes the TRAINER's photo,
                `contain` on a light ground — the ENG-754 rule: this is a
                stable's MARK (often a wordmark logo), and cover-cropping a wide
                logo into a disc keeps the middle two letters and throws the name
                away. Contrast with the head avatar above, which is photography
                and covers. */}
            <PostAvatar url={trainerPhotoUrl} initial={trainerInitial} className="av" />
            <span>{stableLine}</span>
          </div>
        )}
      </div>
      {/* Below the panel box, above the reaction bar — mobile's placement. Its
          `order` is set in globals.css so it lands with the panel in the card's
          reordered flex column. */}
      {needsMore && (
        <button
          type="button"
          className="post-panel-read-more"
          data-testid="post-panel-read-more"
          aria-expanded={expanded}
          aria-label={expanded ? "Read less of this update" : "Read more of this update"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? READ_LESS_LABEL : READ_MORE_LABEL}
        </button>
      )}
    </>
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

// THERE IS NO `variant` PROP, AND NO SHARES CTA. ENG-831's `variant="shares"`
// drew a green "Contact trainer" button that opened the trainer's website; R8
// killed it on mobile (ENG-862, replaced by "See available shares" on the
// trainer profile) and ENG-956 removed it here. Shares posts now live in the
// MAIN feed as ordinary cards, and the only list of for-sale horses is /shares.
// `test/post-card.test.tsx` pins the absence, so it cannot creep back in.
// If an outbound trainer-website link is ever wanted on a card again, reuse
// `WebsiteLink` (ENG-274) rather than reintroducing a card variant.

export function PostCard({
  post,
  viewerId,
  onReact,
  onBookmark,
  onPlay,
  canFollow = false,
  onFollow,
}: PostCardProps) {
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
  // The photo follows the SAME rule as the monogram it replaces, so the head
  // never shows one identity's picture over the other's letter: an update card
  // is the stable's voice and takes the trainer's photo, every other variant is
  // about the horse and takes the horse's. Undefined on a screen that has not
  // resolved photos yet, which simply falls back to the monogram.
  const headPhotoUrl = isUpdate ? post.trainerPhotoUrl : post.horsePhotoUrl;
  // The box takes the asset's OWN ratio, clamped — except a REEL (portrait
  // video), which keeps its true ratio down to 9:16 and takes Instagram's
  // in-feed reel layout: the header overlays the top of the frame on an ink
  // scrim, while actions and caption stay BELOW the media on the card ground
  // (client, 18 Aug 2026: "it shouldnt look like 1:1 with the fullscreen").
  const isReel = isReelMedia(post.media);
  const mediaBox = mediaBoxProps(post.media.aspectRatio, { video: isVideo });
  // Empty unless this post genuinely has 2+ photos, which is what keeps every
  // pre-round-6 card on exactly the path it took before.
  //
  // THIS CARD IS THE ONLY MOUNT. ENG-762's Surface also names
  // `app/(member)/posts/[id]` as a post-detail mount; NO SUCH ROUTE EXISTS in
  // this app — `app/(member)` has explore, following, saved, horses, horses/[id],
  // trainers, trainers/[id], account and checkout, and `app/api/posts/[id]/playback`
  // is an API route, not a page. ENG-761 recorded the same thing. Building one
  // would be a new member screen with no confirmed mockup, which `.rx/guardrails.md`
  // makes `needs-spec`, not part of this ticket. `PhotoCarousel` is shared, so
  // the day that screen exists it mounts in one line. Flagged on the issue.
  const isCarousel = isCarouselPost(post);

  return (
    <article className="post-web">
      {!isReel && (
      <div className="post-head-web">
        <PostAvatar url={headPhotoUrl} initial={initial} />
        <div className="post-meta-web">
          {/* THE STACK (ENG-958, porting mobile ENG-869; Justin, 28 Aug 2026,
              screenshot 1): race badge, then horse name, then trainer + age,
              then the green chip UNDER all three.

              The pill used to sit ABOVE the horse name here. On mobile it
              shared the NAME's line from 26 Aug, capped at 62% of the row, and
              a real title truncated to "Race Replay - Sunsh…" while the name
              beside it also had to shrink — two runs of text fighting over one
              line and both losing. Moving it below the byline gives each of the
              three its own line and gives the chip the whole column, which is
              the truncation fix. Both the race badge and the pill can be on one
              card: the race badge renders FIRST, above; the pill LAST, below.

              Null label = no pill AND no gap — the margin lives on the pill,
              not on the byline above it, so an unlabelled card's head is
              exactly as tall as it was. */}
          {post.raceBadge && (
            <div className={`race-badge${post.raceBadge.kind === "result" ? " result" : ""}`}>{post.raceBadge.text}</div>
          )}
          <h3 className="post-horse">{post.horseName}</h3>
          {/* `post.title` is not drawn AT ALL — on any variant (client, 18
              Aug 2026, in two steps: media cards first, then the update card:
              "dont need the title. same as others"). The data still flows;
              the cards just never render it. */}
          <div className="post-byline">
            <span className="by-trainer">{post.trainerName}</span> · {post.postedAgo}
          </div>
          {/* The `.post-badge` pill is DATA, not card-type copy: `post.label`,
              one of the be's 13 presets (ENG-738), and nothing at all when the
              column is null — which is every pre-round-6 post. `.stacked` is
              what takes it off the old centred one-line treatment and gives it
              the full column. */}
          {post.label && (
            <span className="post-badge stacked">
              {/* The copy is its OWN element so the ellipsis has a block box to
                  apply to — see `.post-badge.stacked .post-badge-text`. */}
              <span className="post-badge-text">{post.label}</span>
            </span>
          )}
        </div>
        <button className="post-more-web" type="button" aria-label="More"><More /></button>
      </div>
      )}

      {hasMedia && (
        <div {...mediaBox}>
          {isCarousel ? (
            // The carousel REPLACES the single poster image and brings its own
            // chip + dots. The box, the Follow pill, the watermark overlay and
            // the aspect ratio all stay exactly where they were.
            //
            // `posterUrl` is handed straight through as slide 0 — the batch
            // minted it, so the first photo is painted before the carousel asks
            // for anything, and index 0 has exactly one source.
            <PhotoCarousel
              postId={post.id}
              slideCount={post.slideCount ?? 1}
              firstUrl={post.media.posterUrl ?? null}
            />
          ) : (
            // Every single-photo and video card takes this path unchanged: one
            // PostMediaImage, no slide index, ENG-813's one-retry recovery.
            <PostMediaImage postId={post.id} src={post.media.posterUrl} video={isVideo} />
          )}
          {isReel && (
            /* THE REEL HEADER — the card's identity on a top scrim, with the
               Follow pill IN the row next to the name (mobile's 18 Aug
               placement: aligned and legible, ENG-606's pill untouched). */
            <div className="reel-head">
              <PostAvatar url={headPhotoUrl} initial={initial} />
              <div className="reel-head-meta">
                {/* SAME STACK AS THE CLASSIC HEAD (Naufal, 31 Aug 2026: the reel
                    follows the post format) — name, byline, then the chip. The
                    reel head carries no race badge, exactly as mobile's does
                    not. It costs one line of picture on a 9:16 asset; accepted
                    on mobile, and accepted here for the same reason. */}
                <h3 className="reel-horse">{post.horseName}</h3>
                <div className="reel-byline">
                  <span className="by-trainer">{post.trainerName}</span> · {post.postedAgo}
                </div>
                {post.label && (
                  <span className="post-badge stacked">
                    <span className="post-badge-text">{post.label}</span>
                  </span>
                )}
              </div>
              {canFollow && <FollowPill trainerName={post.trainerName} onFollow={onFollow} />}
            </div>
          )}
          {isVideo && (
            <button className="media-play" type="button" aria-label="Play video" onClick={onPlay}><Play /></button>
          )}
          {isVideo && post.media.duration && <div className="media-duration">{post.media.duration}</div>}
          {/* The photo's answer to the duration chip: same corner, same scrim.
              A CAROUSEL draws its own chip (it owns the index the chip counts),
              so the card only draws the plain one when there is no carousel. */}
          {post.media.type === "photo" && !isCarousel && <MediaPhotoChip />}
          {post.watermarked && <PostOverlay viewerId={viewerId} />}
          {!isReel && canFollow && <FollowPill trainerName={post.trainerName} onFollow={onFollow} />}
        </div>
      )}

      {showPanel && (
        <PostPanel
          paragraphs={paragraphs}
          stableLine={stableLine}
          trainerInitial={trainerInitial}
          trainerPhotoUrl={post.trainerPhotoUrl}
        />
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
