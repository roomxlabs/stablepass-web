// GET /api/race-day — the Explore "Racing today" band (RF5, ENG-297).
//
// Today's CONFIRMED runners among the horses the viewer follows. Before this
// route, Explore read the `race` table straight from the browser client, which
// (a) showed every horse's runners rather than the viewer's follows and (b) put a
// gated read outside the BFF. Both are fixed here: the read is RLS-scoped
// server-side and the gate returns 402 like every other content route.
//
// Only `entry_status='confirmed'` runners appear — a nominated horse isn't on the
// day's card yet, and scratched / not_accepted are never shown. Empty array →
// the band hides itself (RaceDayBand returns null on []).
//
// GUARDRAIL: no odds/betting fields; no owner identity; `horse_match_proposal`
// (admin-only RLS) is never queried.
import { ok, UNAUTH, GATED } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";
import { raceName, raceDayWhen } from "@/lib/races";

type RaceJoin = {
  venue: string | null;
  race_date: string | null;
  race_number: number | null;
  race_class: string | null;
  distance_m: number | null;
  scheduled_at: string | null;
};
type HorseJoin = { id: string; display_name: string };
type RunnerRow = {
  horse: HorseJoin | HorseJoin[] | null;
  race: RaceJoin | RaceJoin[] | null;
};
type FollowRow = { horse_id: string | null };
type NotifyRow = { horse_id: string | null };

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Local calendar date as YYYY-MM-DD, matching `race.race_date` (a DATE column). */
function todayLocal(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export async function GET() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { data: sub } = await sb.from("subscription").select("status").eq("user_id", user.id).single();
  if (!sub || !["trial", "active"].includes(sub.status)) return GATED();

  // Horses the viewer follows. `follow` is RLS-scoped to the owner, but we filter
  // on user_id explicitly so the query is correct regardless of policy shape.
  const { data: followRows } = await sb
    .from("follow")
    .select("horse_id")
    .eq("user_id", user.id)
    .not("horse_id", "is", null);

  const horseIds = [...new Set(((followRows ?? []) as FollowRow[]).map((f) => f.horse_id).filter((v): v is string => Boolean(v)))];
  if (horseIds.length === 0) return ok({ races: [] });

  const { data: runnerRows } = await sb
    .from("race_horse")
    .select("horse:horse_id(id, display_name), race:race_id(venue, race_date, race_number, race_class, distance_m, scheduled_at)")
    .eq("entry_status", "confirmed")
    .in("horse_id", horseIds);

  // Which of those the viewer has a bell on — drives the band's bell icon.
  const { data: notifyRows } = await sb
    .from("notify_optin")
    .select("horse_id")
    .eq("user_id", user.id)
    .in("horse_id", horseIds);
  const notifySet = new Set(((notifyRows ?? []) as NotifyRow[]).map((n) => n.horse_id));

  const today = todayLocal();
  const races = ((runnerRows ?? []) as RunnerRow[])
    .flatMap((rh) => {
      const race = one(rh.race);
      const horse = one(rh.horse);
      if (!race || !horse || race.race_date !== today) return [];
      return [{
        sortKey: race.scheduled_at ?? "",
        entry: {
          horseId: horse.id,
          horseName: horse.display_name,
          info: `${raceName(race.venue, race.race_number, race.race_class)} · ${race.distance_m ?? "?"}m`,
          when: raceDayWhen(race.scheduled_at),
          notify: notifySet.has(horse.id),
        },
      }];
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map((r) => r.entry);

  return ok({ races });
}
