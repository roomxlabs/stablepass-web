// The horse-profile read — ONE definition for the two call sites that share it.
//
// `GET /api/horses/:id` (the BFF) and `app/(member)/horses/[id]/page.tsx` (which
// reads Supabase directly rather than fetching its own route) read the same
// horse row. They had drifted into two copies of an age formula and BOTH copies
// were wrong the same way (ENG-617):
//
//     new Date().getFullYear() - foaling_year        // one year too old
//
// Southern-hemisphere thoroughbreds age on 1 AUGUST, so a plain year
// subtraction reads every horse a year too old from 1 January to 31 July —
// seven months of every year. It agreed with admin and mobile only because we
// happened to be past 1 August when anyone looked.
//
// The fix is not a better formula, it is NO formula. `horse_age` and
// `horse_description` are PostgREST computed columns (stablepass-be ENG-615)
// derived in Postgres against `Australia/Sydney`. Web therefore does zero age
// arithmetic and adds NO client-side date handling: the browser's timezone
// cannot skew a value it never computes, and the 1 August rollover happens by
// itself on the next read — no deploy, no cron, no code change.
//
// The column list lives here as a constant for the same structural reason
// `ACCESS_COLUMNS` does (lib/api/access.ts): `sb` is untyped, so a `.select()`
// that forgets a computed column type-checks clean and fails only at RUNTIME,
// as an `undefined` that renders as a missing age. One constant, two call
// sites, one place to get it right.

/** One horse's trainer, as embedded by the profile read. */
export type TrainerRow = {
  id: string;
  name: string;
  stable_name: string | null;
  location: string | null;
};

export type HorseProfileRow = {
  id: string;
  sire: string | null;
  dam: string | null;
  display_name: string;
  racing_name: string | null;
  /** Biological sex, `male` | `female` | null. NOT the race-day description. */
  sex: string | null;
  is_gelded: boolean | null;
  colour: string | null;
  /** Editable data in its own right — the derivation's input, not its output. */
  foaling_year: number | null;
  /** Computed in Postgres (1 August, Australia/Sydney). Never computed here. */
  horse_age: number | null;
  /** Computed in Postgres: filly/mare/colt/horse/gelding, or null if unknowable. */
  horse_description: string | null;
  training_status: string;
  starts: number;
  wins: number;
  places: number;
  prize_money_cents: number;
  story: string | null;
  photo_url: string | null;
  trainer: TrainerRow | TrainerRow[] | null;
};

// `sex`, `is_gelded` and `foaling_year` stay in the projection deliberately, and
// none of them is read by either call site today: they are the EDITABLE data
// behind the derivation (admin writes them; ENG-616 is the screen that does),
// while `horse_age`/`horse_description` are read-only output. Keeping them here
// means a surface that starts showing or editing them widens nothing. Both
// column tests pin them, so this is a deliberate contract, not an oversight.
export const HORSE_PROFILE_COLUMNS =
  "id, sire, dam, display_name, racing_name, sex, is_gelded, colour, foaling_year, horse_age, horse_description, training_status, starts, wins, places, prize_money_cents, story, photo_url, trainer:trainer_id(id, name, stable_name, location)";

/**
 * The profile pill — `"5yo · gelding"`. Both halves come from the database; this
 * function only joins them.
 *
 * Named for what it returns (age + race-day DESCRIPTION), not for `sex`: the
 * whole point of the derivation is that `sex` is `male`/`female` and the
 * description is something else entirely, derived from sex AND age.
 *
 * Either half can legitimately be absent: no foaling year means no age, and a
 * non-gelding of unknown age has no honest description (filly-vs-mare is defined
 * BY age), so Postgres returns null rather than guessing. `filter(Boolean)` drops
 * the missing half, so the separator can never lead or trail. Both absent gives
 * `""` — callers must render nothing at all rather than an empty pill.
 */
export function ageDescriptionLine(age: number | null, description: string | null): string {
  return [age != null ? `${age}yo` : null, description].filter(Boolean).join(" · ");
}
