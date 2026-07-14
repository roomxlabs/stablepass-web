// race-day-band — the shared "Racing today" aside card (`.aside-card` +
// `.aside-races`). Presentational only; renders nothing when there are no
// entries so the consumer can drop it in unconditionally.
import type { RaceDayEntry } from "./types";

const Bell = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </svg>
);

export function RaceDayBand({ races }: { races: RaceDayEntry[] }) {
  if (races.length === 0) return null;

  return (
    <div className="aside-card">
      <h3>Racing today</h3>
      <div className="aside-races">
        {races.map((r) => (
          <div className="aside-race" key={r.horseId}>
            <div className="horse-name">
              {r.notify && <Bell />}
              {r.horseName}
            </div>
            <div className="race-info">{r.info}</div>
            <div className="race-time">{r.when}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
