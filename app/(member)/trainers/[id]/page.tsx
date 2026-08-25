// Trainer profile (pattern-based, no mockup — W8). Server component under the
// (member) shell (the sidebar renders via app/(member)/layout.tsx). Mirrors the W7
// horse profile: reads trainer + their horses + derived stats directly via
// supabaseServer (same shape as GET /api/trainers/:id, avoiding an internal fetch);
// the interactive bits (Follow/Notify, the stable grid, the posts) are client
// islands.
//
// GUARDRAIL: `trainer_contact` (admin-only PII) is NEVER selected or rendered here.
// A hidden/unknown trainer → notFound() (404, never 403).
import { notFound } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { signPhoto, TRAINER_PHOTO_BUCKET } from "@/lib/storage/photos";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { AccessWall } from "@/components/access-wall";
import type { HorseSummary } from "@/components/types";
import { FollowNotify } from "./follow-notify";
import { StableHorses } from "./stable-horses";
import { TrainerPosts } from "./trainer-posts";
import { WebsiteLink } from "./website-link";
import { displayHorseNameOrEmpty } from "@/lib/format/horse-name";

type TrainerRow = {
  id: string;
  name: string;
  display_name: string | null;
  stable_name: string | null;
  location: string | null;
  bio: string | null;
  photo_url: string | null;
  website_url: string | null;
};
type HorseRow = { id: string; display_name: string; racing_name: string | null; wins: number };

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: t } = await sb.from("trainer").select("name, display_name").eq("id", id).maybeSingle();
  const name = t ? t.display_name || t.name : "Trainer";
  return { title: `${name} · StablePass` };
}

export default async function TrainerProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  const userId = user!.id;

  // ENG-585 — same raw-status gate as the horse profile; same fix. See the note
  // in app/(member)/horses/[id]/page.tsx.
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

  const { data: trainerRow } = await sb
    .from("trainer")
    .select("id, name, display_name, stable_name, location, bio, photo_url, website_url")
    .eq("id", id)
    .maybeSingle();
  if (!trainerRow) notFound();
  const t = trainerRow as TrainerRow;

  const displayName = t.display_name || t.name;
  const subtitle = [t.stable_name, t.location].filter(Boolean).join(" · ");
  // `photo_url` holds a bare object path in the PRIVATE `trainer-photos` bucket;
  // it must be signed before it can be rendered (see lib/storage/photos.ts).
  const coverUrl = await signPhoto(sb, TRAINER_PHOTO_BUCKET, t.photo_url);

  const [{ data: horseRows }, { count: updates }, { data: followRow }, { data: notifyRow }] = await Promise.all([
    sb.from("horse").select("id, display_name, racing_name, wins").eq("trainer_id", id).eq("status", "active").order("display_name"),
    sb.from("post").select("id", { count: "exact", head: true }).eq("source_trainer_id", id).eq("status", "published"),
    sb.from("follow").select("id").eq("user_id", userId).eq("trainer_id", id).maybeSingle(),
    sb.from("notify_optin").select("id").eq("user_id", userId).eq("trainer_id", id).maybeSingle(),
  ]);

  const horses = (horseRows ?? []) as HorseRow[];
  const wins = horses.reduce((sum, h) => sum + (h.wins ?? 0), 0);
  const stableHorses: HorseSummary[] = horses.map((h) => ({
    id: h.id,
    // Formatted per side of the `||` so a `racing_name` of just "(AUS)" falls
    // through to the display name (ENG-761 item 6).
    name: displayHorseNameOrEmpty(h.racing_name) || displayHorseNameOrEmpty(h.display_name),
    trainerName: displayName,
  }));

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
              <span className="tag active">● Trainer</span>
            </div>
            <h1 className="profile-name-web">{displayName}</h1>
            {subtitle && <p className="profile-pedigree-web">{subtitle}</p>}
          </div>

          {/* Secondary-action row: Follow/Notify plus the optional Website link.
              FollowNotify renders its own .profile-actions-web flex row; nesting it
              here keeps all three actions on one evenly-gapped line without the
              Website link needing a grid cell of its own. */}
          <div className="profile-actions-web">
            <FollowNotify
              trainerId={id}
              userId={userId}
              initialFollowing={Boolean(followRow)}
              initialNotify={Boolean(notifyRow)}
            />
            <WebsiteLink trainerId={id} websiteUrl={t.website_url} />
          </div>

          <div className="profile-stats-web cols-3" style={{ gridColumn: "1 / -1" }}>
            <div className="stat-w"><div className="stat-num">{horses.length}</div><div className="stat-label">Horses</div></div>
            <div className="stat-w"><div className="stat-num">{updates ?? 0}</div><div className="stat-label">Updates</div></div>
            <div className="stat-w"><div className="stat-num">{wins}</div><div className="stat-label">Wins</div></div>
          </div>
        </div>

        <div className="profile-body-grid">
          <div>
            <h2 className="section-title-web">Horses in this stable</h2>
            <StableHorses horses={stableHorses} />

            <h2 className="section-title-web">Recent updates</h2>
            <TrainerPosts trainerId={id} trainerName={displayName} stableName={t.stable_name ?? null} stableLocation={t.location ?? null} viewerId={userId} />
          </div>

          <aside className="feed-aside">
            {t.bio && (
              <div className="aside-card">
                <h3>About {displayName}</h3>
                <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--muted)", margin: 0 }}>{t.bio}</p>
              </div>
            )}

            {(t.stable_name || t.location) && (
              <div className="aside-card">
                <h3>Stable</h3>
                {t.stable_name && <p style={{ fontSize: 14.5, fontWeight: 500, margin: "0 0 4px" }}>{t.stable_name}</p>}
                {t.location && <p style={{ fontSize: 13.5, color: "var(--muted)", margin: 0 }}>{t.location}</p>}
              </div>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
