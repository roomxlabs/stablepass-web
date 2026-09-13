"use client";

// trainer-card — the shared aside "Following" row (`.aside-trainer-row`):
// photo-or-initials avatar + name + horse count. Presentational only.
//
// "use client" since ENG-1057 — see the note in horse-card.tsx. This one matters
// more: the HORSE PROFILE (`app/(member)/horses/[id]/page.tsx`) is a Server
// Component that renders <TrainerCard> directly, with no island in between.
import { useState } from "react";
import type { TrainerSummary } from "./types";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? "?";
  return `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase();
}

export function TrainerCard({ trainer }: { trainer: TrainerSummary }) {
  // Keyed on the url that failed, not a bare boolean — see horse-card.tsx for
  // why a latching flag strands a reused card on its initial.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const photoUrl = trainer.photoUrl && trainer.photoUrl !== failedUrl ? trainer.photoUrl : null;
  return (
    <div className="aside-trainer-row">
      {/* A ROUNDED BOX, NOT A DISC (ENG-1057 decision 3, mobile ENG-833). The
          mini keeps its 36px, but takes `--radius-sm` rather than the grid
          thumbs' `--radius-md`: 14px on a 36px box is nearly a circle, so the
          smaller token is what actually reads as "box with a curved edge" at
          this size. Photo inside the box, mobile-style; initials when there is
          none. */}
      <div className="trainer-avatar-mini" aria-hidden="true">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary signed Storage URL, cover-fit
          <img
            className="trainer-avatar-mini-photo"
            src={photoUrl}
            alt=""
            onError={() => setFailedUrl(trainer.photoUrl ?? null)}
          />
        ) : (
          initials(trainer.name)
        )}
      </div>
      <div className="trainer-info">
        <p className="name">{trainer.name}</p>
        <div className="horses">{trainer.horseCount} horse{trainer.horseCount === 1 ? "" : "s"}</div>
      </div>
    </div>
  );
}
