// Member race reads (RF5, ENG-297) — the shared `race_horse` → `race` read used
// by GET /api/horses/:id and by the horse-profile server component. Extracted so
// the route and the page can't drift apart the way `nextRace` did (the page had a
// verbatim copy of the route's loop).
//
// Runner lifecycle comes from RF1's `race_horse.entry_status`
// ('nominated','confirmed','ran','scratched','not_accepted'):
//   next   — earliest `race.status='upcoming'` with entry_status in (nominated, confirmed)
//   record — entry_status='ran' rows, newest race_date first
// `scratched` and `not_accepted` appear in NEITHER — that's the whole point of the
// lifecycle column, and it's asserted in test/races-lib.test.ts.
//
// GUARDRAIL: no odds/betting fields are read or exposed here, and `horse_match_proposal`
// (admin-only RLS) is never touched — these are member reads under the user's RLS client.

export type EntryStatus = "nominated" | "confirmed" | "ran" | "scratched" | "not_accepted";

/** The next-race card's view model. `barrier`/`jockey` are null while `nominated`. */
export type NextRace = {
  venue: string | null;
  race_number: number | null;
  race_class: string | null;
  distance_m: number | null;
  scheduled_at: string | null;
  entry_status: "nominated" | "confirmed";
  barrier: number | null;
  jockey: string | null;
};

/** One completed run on the profile's race record. */
export type RaceRecordEntry = {
  venue: string | null;
  race_date: string | null;
  race_number: number | null;
  race_class: string | null;
  result: string | null;
  finish_position: number | null;
};

export type HorseRaces = { next: NextRace | null; record: RaceRecordEntry[] };

type RaceJoin = {
  venue: string | null;
  race_date: string | null;
  race_number: number | null;
  race_class: string | null;
  distance_m: number | null;
  scheduled_at: string | null;
  status: string;
};

type RaceHorseRow = {
  entry_status: string | null;
  barrier: number | null;
  jockey: string | null;
  result: string | null;
  finish_position: number | null;
  race: RaceJoin | RaceJoin[] | null;
};

export const RACE_HORSE_SELECT =
  "entry_status, barrier, jockey, result, finish_position, race:race_id(venue, race_date, race_number, race_class, distance_m, scheduled_at, status)";

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/**
 * Minimal structural type for the Supabase client. Deliberately `unknown`-typed
 * and narrowed inside `fetchHorseRaces`: structurally matching the real
 * `SupabaseClient` here makes tsc bail with TS2589 ("type instantiation is
 * excessively deep") because of PostgREST's recursive generic builder.
 */
type QueryClient = { from: (table: string) => unknown };

type RaceHorseQuery = {
  select: (cols: string) => { eq: (col: string, val: string) => PromiseLike<{ data: unknown }> };
};

/**
 * Split a horse's runners into the next-race card and the race record.
 * Pure over the rows so the lifecycle rules are unit-testable without a DB.
 */
export function splitRaces(rows: RaceHorseRow[]): HorseRaces {
  let next: NextRace | null = null;
  let earliest: string | null = null;
  const record: RaceRecordEntry[] = [];

  for (const rh of rows) {
    const race = one(rh.race);
    if (!race) continue;
    const status = rh.entry_status;

    // scratched / not_accepted are dropped entirely — never shown to members.
    if (status === "nominated" || status === "confirmed") {
      if (race.status !== "upcoming" || !race.scheduled_at) continue;
      if (earliest && race.scheduled_at >= earliest) continue;
      earliest = race.scheduled_at;
      const nominated = status === "nominated";
      next = {
        venue: race.venue,
        race_number: race.race_number,
        race_class: race.race_class,
        distance_m: race.distance_m,
        scheduled_at: race.scheduled_at,
        entry_status: status,
        // Barrier + jockey aren't allocated until the runner is accepted, so a
        // nominated entry must not imply them (locked treatment, see the spec).
        barrier: nominated ? null : rh.barrier,
        jockey: nominated ? null : rh.jockey,
      };
    } else if (status === "ran") {
      record.push({
        venue: race.venue,
        race_date: race.race_date,
        race_number: race.race_number,
        race_class: race.race_class,
        result: rh.result,
        finish_position: rh.finish_position,
      });
    }
  }

  record.sort((a, b) => (b.race_date ?? "").localeCompare(a.race_date ?? ""));
  return { next, record };
}

/** Read one horse's races through the caller's RLS-scoped client. */
export async function fetchHorseRaces(sb: QueryClient, horseId: string): Promise<HorseRaces> {
  const query = sb.from("race_horse") as RaceHorseQuery;
  const { data } = await query.select(RACE_HORSE_SELECT).eq("horse_id", horseId);
  return splitRaces((data ?? []) as RaceHorseRow[]);
}

// ---------------------------------------------------------------- presentation

/** "Randwick R5 · BM78" — the next-race card's headline (mockup 07, `.name`). */
export function raceName(venue: string | null, raceNumber: number | null, raceClass: string | null): string {
  return `${venue ?? "TBC"} R${raceNumber ?? "?"}${raceClass ? ` · ${raceClass}` : ""}`;
}

/**
 * "1400m · Barrier 4 · Jockey: T. Berry" — the `.detail` line. A nominated entry
 * carries null barrier/jockey, so it degrades to just the distance.
 */
export function raceDetail(next: Pick<NextRace, "distance_m" | "barrier" | "jockey">): string {
  return [
    next.distance_m ? `${next.distance_m}m` : null,
    next.barrier ? `Barrier ${next.barrier}` : null,
    next.jockey ? `Jockey: ${next.jockey}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "4:35pm" in the viewer's locale clock. */
export function formatClock(iso: string, now: Date = new Date()): string {
  void now;
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

/** The mockup's `.when` row: ["Today · 4:35pm", "In 6 hours"]. */
export function raceWhenParts(iso: string | null, now: Date = new Date()): [string, string] {
  if (!iso) return ["Scheduled", "TBC"];
  const then = new Date(iso);
  const sameDay = then.toDateString() === now.toDateString();
  const day = sameDay
    ? "Today"
    : then.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const diffHours = Math.round((then.getTime() - now.getTime()) / 3_600_000);
  const rel =
    diffHours <= 0
      ? "Now"
      : diffHours === 1
        ? "In 1 hour"
        : diffHours < 24
          ? `In ${diffHours} hours`
          : `In ${Math.round(diffHours / 24)} days`;
  return [`${day} · ${formatClock(iso, now)}`, rel];
}

/** The race-day band's single-line time, e.g. "Today · 4:35pm · in 6 hours". */
export function raceDayWhen(iso: string | null, now: Date = new Date()): string {
  const [day, rel] = raceWhenParts(iso, now);
  return iso ? `${day} · ${rel.toLowerCase()}` : "Today";
}
