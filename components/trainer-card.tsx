// trainer-card — the shared aside "Following" row (`.aside-trainer-row`):
// initials avatar + name + horse count. Presentational only.
import type { TrainerSummary } from "./types";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0][0]?.toUpperCase() ?? "?";
  return `${parts[0][0] ?? ""}${parts[parts.length - 1][0] ?? ""}`.toUpperCase();
}

export function TrainerCard({ trainer }: { trainer: TrainerSummary }) {
  return (
    <div className="aside-trainer-row">
      <div className="trainer-avatar-mini" aria-hidden="true">{initials(trainer.name)}</div>
      <div className="trainer-info">
        <p className="name">{trainer.name}</p>
        <div className="horses">{trainer.horseCount} horse{trainer.horseCount === 1 ? "" : "s"}</div>
      </div>
    </div>
  );
}
