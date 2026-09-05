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
//
// ENG-617: this screen reads Supabase DIRECTLY, so it used to carry its own copy
// of the age formula — and its own copy of the bug. The age and the race-day
// description are now `horse_age` / `horse_description`, computed in Postgres;
// see lib/horse/profile.ts. This file does no date arithmetic.
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { signPhoto, HORSE_PHOTO_BUCKET } from "@/lib/storage/photos";
import {
  HORSE_PROFILE_COLUMNS,
  ageDescriptionLine,
  statusTagClassOf,
  trainingStatusLabel,
  type HorseProfileRow,
} from "@/lib/horse/profile";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { AccessWall } from "@/components/access-wall";
import { TrainerCard } from "@/components/trainer-card";
import { FollowNotify } from "./follow-notify";
import { HorsePosts } from "./horse-posts";
import { WebsiteLink } from "@/app/(member)/trainers/[id]/website-link";
// The validator comes from `lib/`, never from the client component above — see
// the note in lib/trainer/website.ts (calling a client export from a server
// component is a runtime RSC error that tsc does not catch).
import { hasLinkableWebsite } from "@/lib/trainer/website";
import { displayHorseNameOrEmpty } from "@/lib/format/horse-name";

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

// `trainingStatusLabel` used to live here as a naive underscore-strip +
// capitalise. It is now imported from lib/horse/profile.ts (ENG-959): that
// version is mobile's `TRAINING_STATUS_LABEL`, which collapses the legacy
// farm/city spellings to one "In training" instead of inventing two statuses the
// product does not have.

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
  // The tab title is member-facing too, so it takes the same formatting as the
  // heading below rather than the raw registrar caps (ENG-761 item 6).
  const name = horse
    ? displayHorseNameOrEmpty(horse.racing_name) || displayHorseNameOrEmpty(horse.display_name) || "Horse"
    : "Horse";
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

  const { data: horseRow, error: horseError } = await sb
    .from("horse")
    .select(HORSE_PROFILE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  // A query error lands in the same branch as a hidden row (see the matching
  // note in app/api/horses/[id]/route.ts): before H1 deploys, the named computed
  // columns raise 42703 and this notFound()s every horse silently. Log it.
  if (horseError) console.error("horse profile read failed", horseError);
  if (!horseRow) notFound();

  const row = horseRow as HorseProfileRow;
  const trainer = one(row.trainer);
  // Formatted per side of the `||` so a `racing_name` of just "(AUS)" falls
  // through to the display name (ENG-761 item 6).
  const displayName = displayHorseNameOrEmpty(row.racing_name) || displayHorseNameOrEmpty(row.display_name);
  const pedigreeLine = pedigree(row.sire, row.dam);
  // "5yo · gelding" — read from the database's derivation (1 August rule,
  // Australia/Sydney), never computed here. Empty when the row has neither an
  // age nor a description, in which case the pill is not rendered at all.
  const ageDescription = ageDescriptionLine(row.horse_age, row.horse_description);
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

  // The trainer's public `website_url` is read HERE rather than added to the
  // shared `HORSE_PROFILE_COLUMNS` trainer embed (ENG-959). That embed is also
  // consumed by app/api/horses/[id]/route.ts, which returns `trainer` VERBATIM —
  // so widening it would have silently published a new field in that route's
  // response envelope, a contract change made by editing a different file.
  // Reading it on the one screen that needs it keeps the API contract still.
  //
  // Only fetched when this horse is actually for sale: the CTA cannot render
  // otherwise, so the common profile pays nothing for it. Public `website_url`
  // only — never an owner, a contact row or a price (guardrail 2).
  const [{ data: followRow }, { data: notifyRow }, { count: trainerHorseCount }, { data: trainerSite }] =
    await Promise.all([
      sb.from("follow").select("id").eq("user_id", userId).eq("horse_id", id).maybeSingle(),
      sb.from("notify_optin").select("id").eq("user_id", userId).eq("horse_id", id).maybeSingle(),
      trainer
        ? sb.from("horse").select("id", { count: "exact", head: true }).eq("trainer_id", trainer.id)
        : Promise.resolve({ count: 0 } as { count: number | null }),
      trainer && row.shares_for_sale
        ? sb.from("trainer").select("website_url").eq("id", trainer.id).maybeSingle()
        : Promise.resolve({ data: null } as { data: { website_url: string | null } | null }),
    ]);

  // Gated on the VALIDATED href, not on a non-empty string: `WebsiteLink`
  // renders null for anything that is not an absolute http(s) URL, and a bare
  // "wallerracing.com.au" is a realistic admin entry. Gating on truthiness alone
  // would leave the wrapper below drawing an empty, margined row around nothing.
  const showSharesCta = Boolean(row.shares_for_sale) && hasLinkableWebsite(trainerSite?.website_url);

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
              {/* ENG-959 — the shared brown scale, one call, every status. This
                  was `training_status === "racing" ? " race-day" : ""` with a
                  "● Racing" literal: racing was the only status with a colour
                  (and it was the SHARES green), the other four were neutral, and
                  the bullet was drawn here and nowhere else in the product.
                  Mobile's Tag renders the label alone on its own ground, so the
                  bullet goes with the special case that produced it. */}
              <span className={`tag ${statusTagClassOf(row.training_status)}`.trim()}>
                {trainingStatusLabel(row.training_status)}
              </span>
              {ageDescription && <span className="tag">{ageDescription}</span>}
              {/* Justin, 26 Aug: a green "Shares Available" pill sits to the
                  RIGHT of the age/sex tag whenever this horse has shares for
                  sale. It keeps `.race-day` green — it is not a training status,
                  so the brown scale above deliberately does not touch it. */}
              {row.shares_for_sale ? <span className="tag race-day">Shares Available</span> : null}
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
          {/* The `.stats-note-web` caption ("Career stats - updated manually by
              the stable.") is GONE (Justin, 1 Sep 2026, IMG_3520: "Can you
              remove the line"), matching mobile ENG-929. The mockup still draws
              it; this is a client reversal, not drift — do not restore it in a
              fidelity pass. The `.stats-note-web` RULE is left in globals.css
              deliberately even though this was its only user: deleting it is a
              stylesheet cleanup, not this ticket, and globals.css has a sibling
              PR in flight. It is an orphan until something claims it. */}

          {/* Shares CTA — only when THIS horse has shares for sale AND its
              trainer published a linkable public website (ENG-959, gating
              copied from mobile's `contactHref`). Public `website_url` only —
              no owner PII, no prices, no contact row. Reuses the trainer
              profile's <WebsiteLink> rather than a second anchor, so the
              first-party click log, the http(s)-only href validation and the
              middle-click handling are all the one implementation. */}
          {showSharesCta && trainer ? (
            <div className="profile-shares-cta-web">
              <WebsiteLink trainerId={trainer.id} websiteUrl={trainerSite?.website_url ?? null} variant="primary" />
            </div>
          ) : null}
        </div>

        <div className="profile-body-grid">
          <div>
            <h2 className="section-title-web">Recent updates</h2>
            <HorsePosts horseId={id} horseName={displayName} trainerName={trainer?.name ?? "Stablepass"} stableName={trainer?.stable_name ?? null} stableLocation={trainer?.location ?? null} viewerId={userId} />
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
