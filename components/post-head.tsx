"use client";

// post-head — THE card head, for every subject and every mount (ENG-1270).
//
// WHY IT IS ITS OWN COMPONENT. The head markup existed in FIVE places before
// this: `PostCard`'s classic head, `PostCard`'s reel head, and an inline copy in
// each of explore-feed, following-screen, saved-feed and trainer-posts — the
// article those screens render THEMSELVES once a video is playing, because the
// card's media box is replaced by a <video>. Every copy was byte-identical, and
// ENG-558 recorded what that costs: the second copy is the bug. A subject-aware
// head with five copies would have shipped "Unknown horse" over a trainer's
// video on four screens out of five.
//
// WHAT VARIES BY SUBJECT — the head, and ONLY the head (client, 19 Sep 2026:
// there is no new mockup; the trainer and StablePass cards ARE the horse card
// with a different head). Media, carousel, reactions, caption and bookmark are
// untouched, which is also why the horse head below renders the exact markup it
// rendered before — class for class — so the parity screenshot still matches.
import type { CSSProperties, ReactNode } from "react";
import { useState } from "react";
import { resolvePostHead } from "@/lib/feed/subject";
import type { FeedPost } from "./types";

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
 * Photo: web drew an initial letter and nothing else until ENG-958, on every
 * card, while mobile has painted the signed photo since ENG-754. `url` is an
 * ALREADY SIGNED url — this component never mints and never fetches, exactly
 * like the rest of the card; the screens sign in their existing batch
 * (`signPhotoMap`).
 *
 * `onError` → monogram. Not defensive padding: a revoked or rotated bucket
 * object does NOT throw, it resolves to an `<img>` that never paints (see
 * `.rx/gotchas.md`, ENG-815 — "a revoked bucket does not throw, it renders a
 * carousel of nulls"). Falling back on the error event turns that silent broken
 * -image icon back into the monogram the card had before.
 *
 * (It LIVES here rather than in post-card.tsx as of ENG-1270 — the head moved
 * and the avatar is part of the head. `post-card.tsx` re-exports it, so every
 * existing `import { PostAvatar } from "@/components/post-card"` still resolves
 * to this one implementation.)
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
      // `alt=""` + aria-hidden: the subject's name is already the adjacent
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
 * The StablePass S-mark, on brand green.
 *
 * A MARK, NOT A PHOTOGRAPH, so it `contain`s inside the box instead of covering
 * it — the same split ENG-754/ENG-958 drew between the head avatar (`cover`, a
 * photo whose subject is central) and the stable-update panel's footer disc
 * (`contain`, a logo whose edges are the content). Cover-cropping a wordmark
 * keeps the middle two letters and throws the name away.
 *
 * The green ground and the inset are INLINE rather than a class because
 * `app/globals.css` is outside this ticket's declared surface and this is the
 * only element in the app that wants them; both bind the existing `--brand-green`
 * token rather than restating a hex, so a brand change still reaches it.
 */
const MARK_STYLE: CSSProperties = {
  background: "var(--brand-green)",
  objectFit: "contain",
  padding: 8,
};

export function StablePassMark({ className = "post-avatar-web" }: { className?: string }) {
  return (
    // A LOCAL static asset under `public/`, so there is nothing to sign and no
    // error path to recover from — unlike every other avatar on this card.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`${className} post-avatar-photo`}
      src="/brand/mark.png"
      alt=""
      aria-hidden="true"
      data-testid="post-head-mark"
      style={MARK_STYLE}
    />
  );
}

/** The anchor that makes a head tappable — the head row's own flex, inherited ink. */
const HEAD_LINK_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  flex: 1,
  minWidth: 0,
  color: "inherit",
  textDecoration: "none",
};

export type PostHeadVariant = "card" | "reel";

export interface PostHeadProps {
  post: FeedPost;
  /**
   * `card` is the classic head above the media; `reel` is the overlaid header a
   * portrait video draws on its own top scrim. They differ in class names only —
   * same stack, same order, same subject rules.
   */
  variant?: PostHeadVariant;
  /**
   * A stable-update card (`post.type` text/news) is the STABLE's voice, so a
   * HORSE-subject update leads with the trainer's photo and initial while the
   * `h3` stays the horse. That rule predates subjects and is horse-only: a
   * trainer card already shows the trainer, and a StablePass card shows the mark.
   */
  isUpdate?: boolean;
  /** The race badge above the name. Only the classic card head has ever drawn one. */
  showRaceBadge?: boolean;
  /** The green `post.label` pill UNDER the byline (ENG-958's restack). */
  showLabel?: boolean;
  /** The `⋯` post-options control. Classic card head only. */
  showMore?: boolean;
  /** The Follow pill, which sits IN the row on a reel. */
  children?: ReactNode;
}

const More = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
  </svg>
);

export function PostHead({
  post,
  variant = "card",
  isUpdate = false,
  showRaceBadge = false,
  showLabel = false,
  showMore = false,
  children,
}: PostHeadProps) {
  // One resolved model, whatever the screen did: the enriched head when the
  // subject enrichment ran, the horse head rebuilt from the long-standing
  // fields when it did not (an untouched screen, or a pre-B1 row).
  const head = resolvePostHead(post);
  const reel = variant === "reel";

  // `?.` is load-bearing. `PostHead` is a shared exported component and these
  // values reach it from an UNTYPED `sb` payload: an undefined name slipping
  // through would throw here and take the whole feed down, not just this card.
  const trainerInitial = post.trainerName?.[0]?.toUpperCase() ?? "?";
  // The stable-update swap, horse-subject only (see `isUpdate` above).
  const swapToTrainer = head.kind === "horse" && isUpdate;
  const initial = (swapToTrainer ? trainerInitial : head.name?.[0]?.toUpperCase()) ?? "?";
  const avatarUrl = swapToTrainer ? post.trainerPhotoUrl : head.avatarUrl;

  const avatar =
    head.kind === "stablepass" ? <StablePassMark /> : <PostAvatar url={avatarUrl} initial={initial} />;

  const meta = (
    <div className={reel ? "reel-head-meta" : "post-meta-web"}>
      {/* THE STACK (ENG-958, porting mobile ENG-869; Justin, 28 Aug 2026,
          screenshot 1): race badge, then the name, then the byline, then the
          green chip UNDER all three. Both the race badge and the pill can be on
          one card: the badge renders FIRST, above; the pill LAST, below.
          Null label = no pill AND no gap — the margin lives on the pill, not on
          the byline above it, so an unlabelled card's head is exactly as tall
          as it was. */}
      {showRaceBadge && post.raceBadge && (
        <div className={`race-badge${post.raceBadge.kind === "result" ? " result" : ""}`}>{post.raceBadge.text}</div>
      )}
      {/* THE NAME SLOT. The horse's display name, the trainer's name, or the
          literal lowercase `stablepass` — one element, one class, so all three
          variants take the same type ramp and the same truncation.
          `post.title` is not drawn AT ALL on any variant (client, 18 Aug 2026:
          "dont need the title. same as others"). The data still flows; the
          cards just never render it. */}
      <h3 className={reel ? "reel-horse" : "post-horse"} data-subject={head.kind}>
        {head.name}
      </h3>
      {/* LINE 2. The green lead is whatever identifies the poster one level down
          — the trainer (horse), `stable_name · location` (trainer), the
          editorial byline (stablepass) — and the posted-ago text always closes
          it. A null lead renders the time ALONE rather than an orphan `·`. */}
      <div className={reel ? "reel-byline" : "post-byline"}>
        {head.line2 ? (
          <>
            <span className="by-trainer">{head.line2}</span> · {post.postedAgo}
          </>
        ) : (
          post.postedAgo
        )}
      </div>
      {/* The `.post-badge` pill is DATA, not card-type copy: `post.label`, one of
          the be's 13 presets (ENG-738), and nothing at all when the column is
          null. Drawn the same way on all three subjects (client decision 4:
          "label pill as today"). `.stacked` is what gives it the full column. */}
      {showLabel && post.label && (
        <span className="post-badge stacked">
          {/* The copy is its OWN element so the ellipsis has a block box to
              apply to — see `.post-badge.stacked .post-badge-text`. */}
          <span className="post-badge-text">{post.label}</span>
        </span>
      )}
    </div>
  );

  // THE ONLY TAPPABLE HEAD is the trainer's, and it is tappable as a WHOLE —
  // avatar and text together, the way the trainer cards elsewhere in the app
  // behave. The StablePass head is deliberately inert (there is no StablePass
  // profile), and the horse head keeps the flat, unwrapped markup it has always
  // had so its rendered tree is unchanged to the node.
  const identity = head.href ? (
    <a href={head.href} style={HEAD_LINK_STYLE} data-testid="post-head-link">
      {avatar}
      {meta}
    </a>
  ) : (
    <>
      {avatar}
      {meta}
    </>
  );

  if (reel) {
    return (
      <div className="reel-head">
        {identity}
        {children}
      </div>
    );
  }
  return (
    <div className="post-head-web">
      {identity}
      {showMore && (
        // The accessible name is "More" — the `⋯` post-options control.
        <button className="post-more-web" type="button" aria-label="More">
          <More />
        </button>
      )}
      {children}
    </div>
  );
}
