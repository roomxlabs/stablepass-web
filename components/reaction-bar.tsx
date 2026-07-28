"use client";

// reaction-bar — the shared engagement row: a positive-only reaction set + bookmark.
// There is NO comment UI anywhere (guardrail). Purely callback-driven; the consumer
// wires the writes (W6/profiles). The emoji keys match the backend `reaction.emoji`
// CHECK set exactly.
//
// Both states used to be effectively invisible:
//   - reacted  → `.on` only swapped a 1px border colour and a very pale fill, and
//                the glyph <span> carried its own opaque white circle that painted
//                straight over that fill.
//   - saved    → the stylesheet rule that greens the icon was defeated by an inline
//                `fill: currentColor`, and `.bookmarked` never set `color`, so the
//                icon filled muted grey.
// Now the at-rest states carry the message, plus a short-lived confirmation on save
// (which otherwise has no feedback at all).
import { useEffect, useRef, useState } from "react";
import type { ReactionEmoji } from "./types";

// The 7 positive reactions, in display order. Exported so tests assert the exact set.
export const REACTIONS: { key: ReactionEmoji; glyph: string; label: string }[] = [
  { key: "like", glyph: "👍", label: "Like" },
  { key: "love", glyph: "❤️", label: "Love" },
  { key: "clap", glyph: "👏", label: "Clap" },
  { key: "pray", glyph: "🙏", label: "Respect" },
  { key: "fire", glyph: "🔥", label: "Fire" },
  { key: "flex", glyph: "💪", label: "Strong" },
  { key: "horse", glyph: "🐎", label: "Horse" },
];

const TOAST_MS = 2200;

// No inline fill: `.action-web.bookmarked .ic` owns the filled state in CSS, and an
// inline style would outrank it (the bug this replaces).
const Bookmark = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 3h12v18l-6-4-6 4Z" />
  </svg>
);

export interface ReactionBarProps {
  count: number;                 // total reactions (post.like_count)
  reacted: ReactionEmoji | null; // which reaction the viewer picked, if any
  bookmarked: boolean;
  onReact: (emoji: ReactionEmoji) => void;
  onBookmark: () => void;
}

export function ReactionBar({ count, reacted, bookmarked, onReact, onBookmark }: ReactionBarProps) {
  const [savedToast, setSavedToast] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function handleBookmark() {
    // Only confirm the ADD. Removing a bookmark is self-evident from the button
    // dropping back to its outline state, and a toast there would read as an error.
    const adding = !bookmarked;
    onBookmark();
    if (!adding) return;
    setSavedToast(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSavedToast(false), TOAST_MS);
  }

  return (
    <div className="post-actions-web">
      <div className="reactions-web" role="group" aria-label="React">
        {REACTIONS.map((r) => (
          <button
            key={r.key}
            type="button"
            className={reacted === r.key ? "on" : undefined}
            aria-label={r.label}
            aria-pressed={reacted === r.key}
            onClick={() => onReact(r.key)}
          >
            <span aria-hidden="true">{r.glyph}</span>
          </button>
        ))}
      </div>
      {count > 0 && <span className="reaction-count-web">{count}</span>}

      <div className="action-spacer-web" />

      <button
        type="button"
        className={`action-web${bookmarked ? " bookmarked" : ""}`}
        aria-label={bookmarked ? "Remove bookmark" : "Bookmark"}
        aria-pressed={bookmarked}
        onClick={handleBookmark}
      >
        <Bookmark />
        <span className="save-label-web">{bookmarked ? "Saved" : "Save"}</span>
      </button>

      {savedToast && (
        <div className="post-toast-web" role="status" data-testid="saved-toast">
          Saved to your stable
        </div>
      )}
    </div>
  );
}
