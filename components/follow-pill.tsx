"use client";

// follow-pill — the Instagram-style Follow pill that sits top-right of a post's
// media box (round 5, row 5). Net-new in this repo; the same component and the
// same corner as mobile's M3.
//
// Presentational and callback-driven, like everything else in components/: it
// holds no follow state and performs no write. The screen owns both, because
// follow state is a SCREEN-level read (one per screen, never one per card) and
// the pill must disappear for every card by the same trainer at once.
//
// Styling lives in `app/globals.css` under `.post-media-web .media-follow`:
// transparent fill, white 0.95 rim, white label, no shadow, inset 12. The
// transparent fill is a DRI decision that knowingly costs contrast over a bright
// frame — do not add a fill here to make the label pass 4.5:1.
export interface FollowPillProps {
  /** Only for the accessible name — several pills can share one page. */
  trainerName: string;
  onFollow?: () => void;
}

export function FollowPill({ trainerName, onFollow }: FollowPillProps) {
  return (
    <button
      type="button"
      className="media-follow"
      aria-label={`Follow ${trainerName}`}
      onClick={onFollow}
    >
      Follow
    </button>
  );
}
