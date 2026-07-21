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
import { fetchHorseRaces, raceName, raceDetail, raceWhenParts } from "@/lib/races";
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

// How many completed runs the aside card shows. The card has no mockup backing,
// and a campaigner with 24+ starts would otherwise render an aside taller than the
// page; the API still returns the full record. Flagged for the mockup owner.
const RECORD_ROWS = 6;

// The race record's badge text. `race_horse.result` is free text ("2nd of 12");
// fall back to the ordinal finish, then to a neutral "Ran" so a completed run is
// never rendered blank.
function resultLabel(result: string | null, finishPosition: number | null): string {
  if (result) return result;
  if (finishPosition == null) return "Ran";
  const suffix = finishPosition % 100 >= 11 && finishPosition % 100 <= 13
    ? "th"
    : ["th", "st", "nd", "rd"][finishPosition % 10] ?? "th";
  return `${finishPosition}${suffix}`;
}

// "12 Jul 2026" — the record row's date line.
function formatRaceDate(raceDate: string | null): string {
  if (!raceDate) return "";
  const d = new Date(`${raceDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return raceDate;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
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

  const { data: sub } = await sb.from("subscription").select("status").eq("user_id", userId).single();
  const gated = !sub || !["trial", "active"].includes(sub.status);

  if (gated) {
    return (
      <main className="main profile-page">
        <div className="profile-main" style={{ marginTop: 60 }}>
          <div className="aside-card">
            <h3>Your trial has ended.</h3>
            <p style={{ color: "var(--muted)", marginBottom: 16 }}>
              Reactivate your subscription to see this horse&rsquo;s profile.
            </p>
            <a className="btn btn-primary" href="/checkout">Reactivate</a>
          </div>
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
  const coverUrl = row.photo_url ?? null;
  const about = row.story ?? null;

  // Next race + race record, split by RF1's `entry_status` lifecycle — the same
  // helper GET /api/horses/:id uses, so the page and its route can't drift.
  const { next: nextRace, record } = await fetchHorseRaces(sb, id);
  const nextWhen = nextRace ? raceWhenParts(nextRace.scheduled_at) : null;

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
            {/* Next race (mockup 07 `.next-race-web`). `nominated` reuses the same
                card with a "Nominated" label and no barrier/jockey — those aren't
                allocated until the runner is accepted (locked treatment: the
                mockups predate the nomination decision, so nothing is invented
                beyond the label). No next race → the card is absent entirely. */}
            {nextRace && nextWhen && (
              <div className="next-race-web" data-testid="next-race">
                <div className="label">
                  Next race{nextRace.entry_status === "nominated" ? " · Nominated" : ""}
                </div>
                <div className="name">
                  {raceName(nextRace.venue, nextRace.race_number, nextRace.race_class)}
                </div>
                <div className="detail">{raceDetail(nextRace)}</div>
                <div className="when">
                  <span>{nextWhen[0]}</span>
                  <strong>{nextWhen[1]}</strong>
                </div>
              </div>
            )}

            {/* Race record — completed runs (`entry_status='ran'`), newest first.
                No mockup backs this card, so it is composed strictly from existing
                design-system primitives: the `.aside-card` + `.aside-race` row from
                the "Racing today" band, with the gold `.race-badge.result` the
                design system already designates for a result. */}
            {record.length > 0 && (
              <div className="aside-card" data-testid="race-record">
                <h3>Race record</h3>
                <div className="aside-races">
                  {record.slice(0, RECORD_ROWS).map((r, i) => (
                    <div className="aside-race" key={`${r.race_date ?? "?"}-${r.race_number ?? i}`}>
                      <span className="race-badge result">{resultLabel(r.result, r.finish_position)}</span>
                      <div className="horse-name">{raceName(r.venue, r.race_number, r.race_class)}</div>
                      <div className="race-info">{formatRaceDate(r.race_date)}</div>
                    </div>
                  ))}
                </div>
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
