// GET /api/horses/:id — the horse-profile screen's read (W7, ENG-200). A direct
// RLS-scoped read (horse_select_sub gates to active + content-access) — there is
// no be edge fn for this yet, unlike /api/feed. No row ever surfaces as 404, not
// 403 (enumeration-resistance guardrail): a hidden/disabled/foreign horse looks
// identical to a nonexistent one.
//
// Career stats (starts/wins/places/prize_money_cents), the cover (photo_url) and
// the About blurb (story) all live directly on `horse` — hand-maintained by the
// stable (see the mockup's stats-note copy), not derived from `race_horse`.
//
// ENG-617: the age is NOT computed here. `horse_age` / `horse_description` are
// PostgREST computed columns derived in Postgres on the 1 August rule; see
// lib/horse/profile.ts for why this route does no date arithmetic at all.
import { ok, fail, UNAUTH, GATED } from "@/lib/api/envelope";
import { hasAccess, ACCESS_COLUMNS } from "@/lib/api/access";
import { supabaseServer } from "@/lib/supabase/server";
import { signPhoto, HORSE_PHOTO_BUCKET } from "@/lib/storage/photos";
import { HORSE_PROFILE_COLUMNS, ageDescriptionLine, type HorseProfileRow } from "@/lib/horse/profile";

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

  const { data: sub } = await sb.from("subscription").select(ACCESS_COLUMNS).eq("user_id", user.id).single();
  if (!hasAccess(sub)) return GATED();

  const { data: horseRow, error: horseError } = await sb
    .from("horse")
    .select(HORSE_PROFILE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  // The 404 is deliberate for a hidden/foreign row (enumeration resistance), but
  // a QUERY error lands in the same branch and must not be silent: before H1
  // (ENG-615) is deployed, the named computed columns raise 42703 and EVERY
  // horse profile 404s, indistinguishable from a genuinely hidden horse. Log it
  // so the deploy-order failure is loud. Never "fix" a 42703 by trimming the
  // projection — naming the columns is the point.
  if (horseError) console.error("horse profile read failed", horseError);
  if (!horseRow) return fail("not_found", "Horse not found.", 404);

  const row = horseRow as HorseProfileRow;
  // `photo_url` is STRIPPED before this leaves the server (ENG-958).
  //
  // ENG-958 added `trainer.photo_url` to the shared `HORSE_PROFILE_COLUMNS` so
  // the horse PROFILE PAGE could sign it for the post-card avatars. That
  // constant has two consumers, and this route is the other one — it returns the
  // embedded trainer verbatim, so the widening would have shipped a bare
  // `trainer-photos` OBJECT PATH to browser JS. That is the exact escape hatch
  // `lib/storage/photos.ts` exists to close: a path is not the bytes (minting
  // still runs under the viewer's RLS), but an unsigned path in an envelope is
  // one consumer away from being rendered into an `<img src>`, where it would
  // resolve against the page and silently return HTML.
  //
  // Nothing consumes this field today, which is precisely why it needed a
  // deliberate decision now rather than a discovery later. The route already
  // signs the horse's own cover below for the same reason.
  // The `?? null` is load-bearing: a horse with no trainer must still serialise
  // as `trainer: null`, not as an empty object. Destructuring straight off a
  // `?? {}` would quietly change this envelope's shape for every trainerless
  // horse — a contract change smuggled in behind a security fix.
  const trainerRow = one(row.trainer);
  const trainer = trainerRow
    ? (({ photo_url: _photoPath, ...rest }) => rest)(trainerRow)
    : null;

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
      // "5yo · gelding", straight from the database's derivation — no local
      // arithmetic, so this flips itself on 1 August without a deploy.
      ageDescription: ageDescriptionLine(row.horse_age, row.horse_description),
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
