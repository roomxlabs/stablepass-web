// GET /api/horses/:id — the horse-profile screen's read (W7, ENG-200). A direct
// RLS-scoped read (horse_select_sub gates to active + content-access) — there is
// no be edge fn for this yet, unlike /api/feed. No row ever surfaces as 404, not
// 403 (enumeration-resistance guardrail): a hidden/disabled/foreign horse looks
// identical to a nonexistent one.
//
// Career stats (starts/wins/places/prize_money_cents), the cover (photo_url) and
// the About blurb (story) all live directly on `horse` — hand-maintained by the
// stable (see the mockup's stats-note copy), not derived from `race_horse`.
import { ok, fail, UNAUTH, GATED } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";
import { signPhoto, HORSE_PHOTO_BUCKET } from "@/lib/storage/photos";

type TrainerRow = { id: string; name: string; stable_name: string | null; location: string | null };
type HorseRow = {
  id: string;
  sire: string | null;
  dam: string | null;
  display_name: string;
  racing_name: string | null;
  sex: string | null;
  colour: string | null;
  foaling_year: number | null;
  training_status: string;
  starts: number;
  wins: number;
  places: number;
  prize_money_cents: number;
  story: string | null;
  photo_url: string | null;
  trainer: TrainerRow | TrainerRow[] | null;
};
type NextRaceRow = {
  barrier: number | null;
  jockey: string | null;
  race:
    | { venue: string | null; race_number: number | null; race_class: string | null; distance_m: number | null; scheduled_at: string | null; status: string }
    | { venue: string | null; race_number: number | null; race_class: string | null; distance_m: number | null; scheduled_at: string | null; status: string }[]
    | null;
};

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// "by ${sire} out of ${dam}" — omit either half that's null; null if both are.
function pedigree(sire: string | null, dam: string | null): string | null {
  if (!sire && !dam) return null;
  if (sire && dam) return `by ${sire} out of ${dam}`;
  return sire ? `by ${sire}` : `out of ${dam}`;
}

function ageSex(foalingYear: number | null, sex: string | null): string {
  const age = foalingYear ? new Date().getFullYear() - foalingYear : null;
  return [age != null ? `${age}yo` : null, sex].filter(Boolean).join(" · ");
}

// prize_money_cents -> "$1.2M" (>=$1m), "$45k" (>=$1k), else "$N".
function formatPrize(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars)}`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { data: sub } = await sb.from("subscription").select("status").eq("user_id", user.id).single();
  if (!sub || !["trial", "active"].includes(sub.status)) return GATED();

  const { data: horseRow } = await sb
    .from("horse")
    .select(
      "id, sire, dam, display_name, racing_name, sex, colour, foaling_year, training_status, starts, wins, places, prize_money_cents, story, photo_url, trainer:trainer_id(id, name, stable_name, location)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!horseRow) return fail("not_found", "Horse not found.", 404);

  const row = horseRow as HorseRow;
  const trainer = one(row.trainer);

  // Next race — earliest upcoming scheduled_at, or null.
  const { data: nextRaceRows } = await sb
    .from("race_horse")
    .select("barrier, jockey, race:race_id(venue, race_number, race_class, distance_m, scheduled_at, status)")
    .eq("horse_id", id);

  let nextRace: { label: string; name: string; detail: string } | null = null;
  let earliest: string | null = null;
  for (const rh of (nextRaceRows ?? []) as NextRaceRow[]) {
    const race = one(rh.race);
    if (!race || race.status !== "upcoming" || !race.scheduled_at) continue;
    if (!earliest || race.scheduled_at < earliest) {
      earliest = race.scheduled_at;
      nextRace = {
        label: "Next race",
        name: `${race.venue ?? "TBC"} R${race.race_number ?? "?"}${race.race_class ? ` · ${race.race_class}` : ""}`,
        detail: [
          race.distance_m ? `${race.distance_m}m` : null,
          rh.barrier ? `Barrier ${rh.barrier}` : null,
          rh.jockey ? `Jockey: ${rh.jockey}` : null,
        ].filter(Boolean).join(" · "),
      };
    }
  }

  return ok({
    horse: {
      id: row.id,
      displayName: row.racing_name || row.display_name,
      pedigree: pedigree(row.sire, row.dam),
      ageSex: ageSex(row.foaling_year, row.sex),
      trainingStatus: row.training_status,
      // Signed, never the raw path: `horse-photos` is a private bucket.
      coverUrl: await signPhoto(sb, HORSE_PHOTO_BUCKET, row.photo_url),
      about: row.story ?? null,
    },
    trainer,
    stats: { starts: row.starts, wins: row.wins, places: row.places, prizeMoney: formatPrize(row.prize_money_cents) },
    nextRace,
  });
}
