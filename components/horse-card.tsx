// horse-card — the shared browse/profile horse card (`.horse-card-web`, same
// thumb/name/trainer skin as the onboarding picker, minus the selection check).
// Presentational + callback-driven; the consumer wires navigation.
import type { HorseSummary } from "./types";

export interface HorseCardProps {
  horse: HorseSummary;
  onClick?: () => void;
}

export function HorseCard({ horse, onClick }: HorseCardProps) {
  const initial = horse.name[0]?.toUpperCase() ?? "?";
  return (
    <button type="button" className="horse-card-web" onClick={onClick}>
      <div className="horse-thumb" aria-hidden="true">{initial}</div>
      {horse.raceDay && <div className="race-badge">Race day</div>}
      <div className="horse-name">{horse.name}</div>
      <div className="horse-trainer">{horse.trainerName}</div>
    </button>
  );
}
