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

/** One horse's trainer, as embedded by the profile read.
 *
 *  DELIBERATELY NOT WIDENED with `website_url` (ENG-959). This embed has TWO
 *  consumers, and the second one is easy to miss: `app/api/horses/[id]/route.ts`
 *  returns `trainer` VERBATIM into its response envelope, so any field added
 *  here is also published to every caller of that BFF route — a response-shape
 *  change made by editing a different file, with no test in front of it. The
 *  shares CTA needs the website on ONE screen, so that screen reads it itself
 *  (see the note in app/(member)/horses/[id]/page.tsx) rather than changing a
 *  contract shared with the API. */
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
  /** Drives the green "Shares Available" pill and gates the website CTA
   *  (ENG-959). The flag itself is the ONLY shares signal on this screen. */
  shares_for_sale: boolean | null;
  trainer: TrainerRow | TrainerRow[] | null;
};

// `sex`, `is_gelded` and `foaling_year` stay in the projection deliberately, and
// none of them is read by either call site today: they are the EDITABLE data
// behind the derivation (admin writes them; ENG-616 is the screen that does),
// while `horse_age`/`horse_description` are read-only output. Keeping them here
// means a surface that starts showing or editing them widens nothing. Both
// column tests pin them, so this is a deliberate contract, not an oversight.
// `shares_for_sale` (ENG-959) is safe to add HERE, unlike a trainer field: the
// BFF route (app/api/horses/[id]/route.ts) picks the `horse` object's fields
// one by one, so a new horse column changes no response shape — whereas it
// returns the `trainer` embed verbatim (see TrainerRow above). It is also an
// already-deployed column that other screens select directly (horses-grid.tsx
// filters on it), so it cannot trip the 42703-blackout gotcha an undeployed
// column would — a raise there notFound()s every horse silently.
export const HORSE_PROFILE_COLUMNS =
  "id, sire, dam, display_name, racing_name, sex, is_gelded, colour, foaling_year, horse_age, horse_description, training_status, starts, wins, places, prize_money_cents, story, photo_url, shares_for_sale, trainer:trainer_id(id, name, stable_name, location)";

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

// ---------------------------------------------------------------------------
// The status scale + labels — ported from mobile (ENG-959 parity)
// ---------------------------------------------------------------------------

/**
 * `horse.training_status` -> the status tag's COLOUR CLASS. The web half of
 * mobile's `statusTagVariantOf` (src/components/ui/tag.tsx), ported verbatim in
 * BEHAVIOUR — same raw values, same collapsing, same neutral default.
 *
 * The scale itself (ENG-866, re-cut on Justin's 1 Sep 2026 note): Breaking In
 * light gold, Pre-training light green, In training dark green, Racing dark
 * saddle brown, spelling/retired bland (the plain `.tag`, which is why there is
 * no `status-spelling` class — neutral IS the default tag). The hexes live in
 * app/globals.css beside `.tag`; this function only names the class.
 *
 * WHY IT TAKES THE RAW VALUE, never the label: labels are copy and have already
 * changed once (`TRAINING_STATUS_LABEL` below). Keying colour off the taxonomy
 * means a rename cannot silently decolour a pill. This screen previously
 * compared `row.training_status === "racing"` INLINE and coloured every other
 * status neutral — one status special-cased, four unstyled.
 *
 * NOT YET UNIVERSAL, and worth knowing before you assume it is: the shares list
 * (app/(member)/shares/shares-list.tsx) still carries its own `sharesStatusLabel`
 * switch and its own `trainingStatus === "racing" ? "race-day" : "active"` — the
 * very special case this function replaces. That file is outside ENG-959's
 * surface, so after this ticket the same horse renders on the brown scale here
 * and on the old green one there. Folding /shares onto this mapping is a
 * follow-up; do not fix it by re-deriving a colour at that call site.
 *
 * "In training" is `--brand-green-dark`, not `--brand-green`, on purpose: the
 * "Shares Available" chip in this very status row is `--brand-green`
 * (`.tag.race-day`), and an In-training pill beside it must not read as a second
 * copy of that chip.
 */
export function statusTagClassOf(trainingStatus: string | null | undefined): string {
  switch (trainingStatus) {
    case "racing":
      return "status-racing";
    case "breaking_in":
      return "status-breaking";
    case "pre_training":
      return "status-pre-training";
    case "in_training":
    // farm/city are LEGACY spellings of in_training — the 1 Sep 2026 migration
    // merges the rows, and these cases only cover a client rendering before it
    // deploys (or a cached row). Colour them as what they are about to become,
    // never as a fourth state.
    case "farm_training":
    case "city_training":
      return "status-in-training";
    // spelling / retired / unknown — bland, i.e. the plain neutral tag.
    default:
      return "";
  }
}

/**
 * `horse.training_status` -> its LABEL. Ported from mobile lib/profiles.ts.
 *
 * Replaces a naive `status.replace(/_/g, " ")` + capitalise, which got two of
 * these wrong: `breaking_in` rendered "Breaking in" only by luck of the
 * underscore, and `farm_training`/`city_training` rendered "Farm training" /
 * "City training" — Justin, 26 Aug 2026: both training yards read "In training",
 * because many horses are trained from country tracks and "City training" is
 * misleading.
 */
const TRAINING_STATUS_LABEL: Record<string, string> = {
  spelling: "Spelling",
  // Justin, 1 Sep 2026: "their first stage of education is Breaking In".
  breaking_in: "Breaking in",
  pre_training: "Pre-training",
  in_training: "In training",
  farm_training: "In training",
  city_training: "In training",
  racing: "Racing",
  retired: "Retired",
};

/** Unknown/absent statuses fall back to "Spelling", exactly as mobile does. */
export function trainingStatusLabel(status: string | null | undefined): string {
  return TRAINING_STATUS_LABEL[status ?? "spelling"] ?? "Spelling";
}
