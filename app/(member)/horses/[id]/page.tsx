// Horse profile (07-horse-profile.html). Server component under the (member)
// shell (the sidebar already renders via app/(member)/layout.tsx — this route
// only renders <main className="main profile-page">). Reads horse + trainer +
// career stats + next race directly via supabaseServer (same shape as
// GET /api/horses/:id, avoiding an internal fetch); the interactive bits
// (Follow/Notify, the posts feed) are small client islands.
//
// Career stats (starts/wins/places/prize_money_cents), the cover (photo_url) and
// the About blurb (story) all live directly on `horse` — hand-maintained by the
// stable, not derived from `race_horse`.
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { signPhoto, HORSE_PHOTO_BUCKET } from "@/lib/storage/photos";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { AccessWall } from "@/components/access-wall";
import { TrainerCard } from "@/components/trainer-card";
import { FollowNotify } from "./follow-notify";
import { HorsePosts } from "./horse-posts";

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

function pedigree(sire: string | null, dam: string | null): string | null {
  if (!sire && !dam) return null;
  if (sire && dam) return `by ${sire} out of ${dam}`;
  return sire ? `by ${sire}` : `out of ${dam}`;
}

function ageSexLabel(foalingYear: number | null, sex: string | null): string {
  const age = foalingYear ? new Date().getFullYear() - foalingYear : null;
  return [age != null ? `${age}yo` : null, sex].filter(Boolean).join(" · ");
}

function trainingStatusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// prize_money_cents -> "$1.2M" (>=$1m), "$45k" (>=$1k), else "$N" — mirrors
// GET /api/horses/:id's formatPrize (route.ts), duplicated here since this
// page reads `horse` directly rather than calling its own BFF route.
function formatPrize(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
  return `$${Math.round(dollars)}`;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: horse } = await sb.from("horse").select("display_name, racing_name").eq("id", id).maybeSingle();
  const name = horse ? horse.racing_name || horse.display_name : "Horse";
  return { title: `${name} · StablePass` };
}

export default async function HorseProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  const userId = user!.id;

  // ENG-585: was `!["trial","active"].includes(sub.status)` on a status-only
  // select — an expired `active` member sailed past this gate and fell through
  // to a profile RLS then refused to populate. `hasAccess()` (via
  // readSubscriptionState) is the shared rule; it is strictly stricter than the
  // status test it replaces, so this can only ever wall MORE members, never
  // reveal content to one.
  const { entitled, everSubscribed } = await readSubscriptionState(userId);

  if (!entitled) {
    return (
      <main className="main profile-page">
        <div className="profile-main" style={{ marginTop: 60 }}>
          <AccessWall everSubscribed={everSubscribed} />
        </div>
      </main>
    );
  }

  const { data: horseRow } = await sb
    .from("horse")
    .select(
      "id, sire, dam, display_name, racing_name, sex, colour, foaling_year, training_status, starts, wins, places, prize_money_cents, story, photo_url, trainer:trainer_id(id, name, stable_name, location)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!horseRow) notFound();

  const row = horseRow as HorseRow;
  const trainer = one(row.trainer);
  const displayName = row.racing_name || row.display_name;
  const pedigreeLine = pedigree(row.sire, row.dam);
  // `photo_url` holds a bare object path in the PRIVATE `horse-photos` bucket;
  // it must be signed before it can be rendered (see lib/storage/photos.ts).
  const coverUrl = await signPhoto(sb, HORSE_PHOTO_BUCKET, row.photo_url);
  const about = row.story ?? null;

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

  const [{ data: followRow }, { data: notifyRow }, { count: trainerHorseCount }] = await Promise.all([
    sb.from("follow").select("id").eq("user_id", userId).eq("horse_id", id).maybeSingle(),
    sb.from("notify_optin").select("id").eq("user_id", userId).eq("horse_id", id).maybeSingle(),
    trainer
      ? sb.from("horse").select("id", { count: "exact", head: true }).eq("trainer_id", trainer.id)
      : Promise.resolve({ count: 0 } as { count: number | null }),
  ]);

  // "About {name}" prefers the horse's own story; falls back to the trainer's
  // stable/location line when there's no story yet.
  const trainerLine = trainer ? [trainer.stable_name, trainer.location].filter(Boolean).join(" · ") : "";
  const aboutText = about || trainerLine;

  return (
    <main className="main profile-page">
      <div className="profile-cover-web">
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary Storage cover URL, cover-fit
          <img src={coverUrl} alt="" />
        ) : null}
        <div className="gradient" />
      </div>

      <div className="profile-main">
        <div className="profile-header-web">
          <div className="profile-head-left">
            <div className="status-row">
              <span className={`tag${row.training_status === "racing" ? " race-day" : ""}`}>
                {row.training_status === "racing" ? "● Racing" : trainingStatusLabel(row.training_status)}
              </span>
              <span className="tag">{ageSexLabel(row.foaling_year, row.sex)}</span>
            </div>
            <h1 className="profile-name-web">{displayName}</h1>
            {pedigreeLine && <p className="profile-pedigree-web">{pedigreeLine}</p>}
          </div>

          <FollowNotify
            horseId={id}
            userId={userId}
            initialFollowing={Boolean(followRow)}
            initialNotify={Boolean(notifyRow)}
          />

          <div className="profile-stats-web" style={{ gridColumn: "1 / -1" }}>
            <div className="stat-w"><div className="stat-num">{row.starts}</div><div className="stat-label">Starts</div></div>
            <div className="stat-w"><div className="stat-num">{row.wins}</div><div className="stat-label">Wins</div></div>
            <div className="stat-w"><div className="stat-num">{row.places}</div><div className="stat-label">Places</div></div>
            <div className="stat-w"><div className="stat-num">{formatPrize(row.prize_money_cents)}</div><div className="stat-label">Prizemoney</div></div>
          </div>
          <div className="stats-note-web" style={{ gridColumn: "1 / -1" }}>Career stats - updated manually by the stable.</div>
        </div>

        <div className="profile-body-grid">
          <div>
            <h2 className="section-title-web">Recent updates</h2>
            <HorsePosts horseId={id} horseName={displayName} trainerName={trainer?.name ?? "Stablepass"} viewerId={userId} />
          </div>

          <aside className="feed-aside">
            {nextRace && (
              <div className="next-race-web">
                <div className="label">{nextRace.label}</div>
                <div className="name">{nextRace.name}</div>
                <div className="detail">{nextRace.detail}</div>
              </div>
            )}

            {trainer && (
              <div className="aside-card">
                <h3>Trainer</h3>
                <TrainerCard trainer={{ id: trainer.id, name: trainer.name, horseCount: trainerHorseCount ?? 0 }} />
              </div>
            )}

            {aboutText && (
              <div className="aside-card">
                <h3>About {displayName}</h3>
                <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--muted)", margin: 0 }}>{aboutText}</p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
