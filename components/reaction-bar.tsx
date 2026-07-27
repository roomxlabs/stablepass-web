"use client";

// reaction-bar — the shared engagement row: a positive-only reaction set + bookmark.
// There is NO comment UI anywhere (guardrail). Purely callback-driven; the consumer
// wires the writes (W6/profiles). The emoji keys match the backend `reaction.emoji`
// CHECK set exactly.
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

const Bookmark = ({ filled }: { filled: boolean }) => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" style={filled ? { fill: "currentColor" } : undefined}>
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
      {count > 0 && <span className="action-web" style={{ marginLeft: 10 }}>{count}</span>}

      <div className="action-spacer-web" />

      <button
        type="button"
        className={`action-web${bookmarked ? " bookmarked" : ""}`}
        aria-label={bookmarked ? "Remove bookmark" : "Bookmark"}
        aria-pressed={bookmarked}
        onClick={onBookmark}
      >
        <Bookmark filled={bookmarked} />
      </button>
    </div>
  );
}
