// GET /api/trainers/:id — the trainer-profile screen's read (W8, ENG-201). A direct
// RLS-scoped read (trainer_select_sub gates to content-access); no be edge fn.
// Hidden/unknown trainer → 404, never 403 (enumeration-resistance guardrail).
//
// Stats are derived + RLS-honest: Horses = count of the trainer's active horses,
// Updates = count of their published posts, Wins = Σ their horses' `wins`. (No
// follower count — `follow` rows are owner-scoped under RLS, so a member can't
// count a trainer's followers without a backend RPC — deferred.)
//
// GUARDRAIL: `trainer_contact` is admin-only PII and is NEVER selected here.
import { ok, fail, UNAUTH, GATED } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";
import { signPhoto, TRAINER_PHOTO_BUCKET } from "@/lib/storage/photos";

type TrainerRow = {
  id: string;
  name: string;
  display_name: string | null;
  stable_name: string | null;
  location: string | null;
  bio: string | null;
  photo_url: string | null;
};
type HorseRow = { id: string; display_name: string; racing_name: string | null; wins: number };

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { data: sub } = await sb.from("subscription").select("status").eq("user_id", user.id).single();
  if (!sub || !["trial", "active"].includes(sub.status)) return GATED();

  const { data: trainerRow } = await sb
    .from("trainer")
    .select("id, name, display_name, stable_name, location, bio, photo_url")
    .eq("id", id)
    .maybeSingle();
  if (!trainerRow) return fail("not_found", "Trainer not found.", 404);
  const t = trainerRow as TrainerRow;

  // Their active horses (RLS horse_select_sub already gates to active + content-access).
  const { data: horseRows } = await sb
    .from("horse")
    .select("id, display_name, racing_name, wins")
    .eq("trainer_id", id)
    .eq("status", "active")
    .order("display_name");
  const horses = (horseRows ?? []) as HorseRow[];

  // Updates = count of this trainer's published posts (RLS post_select_sub gated).
  const { count: updates } = await sb
    .from("post")
    .select("id", { count: "exact", head: true })
    .eq("source_trainer_id", id)
    .eq("status", "published");

  const wins = horses.reduce((sum, h) => sum + (h.wins ?? 0), 0);

  return ok({
    trainer: {
      id: t.id,
      displayName: t.display_name || t.name,
      stableName: t.stable_name,
      location: t.location,
      bio: t.bio,
      // Signed, never the raw path: `trainer-photos` is a private bucket.
      coverUrl: await signPhoto(sb, TRAINER_PHOTO_BUCKET, t.photo_url),
    },
    stats: { horses: horses.length, updates: updates ?? 0, wins },
    horses: horses.map((h) => ({ id: h.id, name: h.racing_name || h.display_name })),
  });
}
