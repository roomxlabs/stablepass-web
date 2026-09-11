"use client";

// horse-card — the shared browse/profile horse card (`.horse-card-web`, same
// thumb/name/trainer skin as the onboarding picker, minus the selection check).
// Presentational + callback-driven; the consumer wires navigation.
//
// "use client" since ENG-1057: the thumb keeps one bit of state (whether the
// photo failed to load) so an expired/denied signed URL falls back to the
// initial instead of painting a broken-image glyph. The horse PROFILE page is a
// Server Component and renders this via the <StableHorses> island, so the
// directive is what keeps that legal.
import { useState } from "react";
import type { HorseSummary } from "./types";

export interface HorseCardProps {
  horse: HorseSummary;
  onClick?: () => void;
}

export function HorseCard({ horse, onClick }: HorseCardProps) {
  const initial = horse.name[0]?.toUpperCase() ?? "?";
  // Track WHICH url failed, not merely THAT one did.
  //
  // A bare `failed` boolean latches for the life of the component instance, and
  // these instances are reused: the grids key their cards by `h.id`, so an
  // All -> Following -> All flip re-renders the SAME card with a FRESHLY signed
  // url. A card that lost one image (a transient network blip, or a url that had
  // aged past its hour) would then stay on its initial forever, even though
  // there is now a good url to try. Comparing against the url that actually
  // failed resets the fallback for free the moment a different one arrives —
  // and still never retries the SAME dead url, which is the property that
  // matters (these are 1-hour signed urls; retrying one that 403s just loops).
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const photoUrl = horse.photoUrl && horse.photoUrl !== failedUrl ? horse.photoUrl : null;
  return (
    <button type="button" className="horse-card-web" onClick={onClick}>
      {/* MOBILE PARITY (`src/components/horse-row.tsx`): the photo sits INSIDE
          the thumb box — mobile's `<View style={thumb}>` wrapping an absolute
          -fill `<Image contentFit="cover">` — so the box keeps its size, its
          `--radius-md` corner and its `overflow: hidden` clip, and the photo
          simply fills it. When there is no photo the box draws the initial on
          the web gradient exactly as it always has (ENG-1057 decision 7: the
          web ground stays, mobile's muted `.thumb-initial` ground is NOT
          ported). */}
      <div className="horse-thumb" aria-hidden="true">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary signed Storage URL, cover-fit
          <img
            className="horse-thumb-photo"
            src={photoUrl}
            alt=""
            onError={() => setFailedUrl(horse.photoUrl ?? null)}
          />
        ) : (
          initial
        )}
      </div>
      {horse.raceDay && <div className="race-badge">Race day</div>}
      <div className="horse-name">{horse.name}</div>
      <div className="horse-trainer">{horse.trainerName}</div>
    </button>
  );
}
