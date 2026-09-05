// GET /api/trainers/:id/feed — the trainer-profile "Recent updates" list (W8,
// ENG-201). A DIRECT read of this trainer's own published posts (source_trainer_id),
// chronological — unlike /api/feed this does NOT go through the be feed fn, so it
// works end-to-end against the local Postgres stack. Each post carries its horse's
// name so the byline is per-horse (a trainer's updates span their whole stable).
import { ok, UNAUTH, GATED } from "@/lib/api/envelope";
import { hasAccess, ACCESS_COLUMNS } from "@/lib/api/access";
import { POST_INTRINSIC_COLUMNS } from "@/lib/feed/post-row";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { data: sub } = await sb.from("subscription").select(ACCESS_COLUMNS).eq("user_id", user.id).single();
  if (!hasAccess(sub)) return GATED();

  const { data: posts } = await sb
    .from("post")
    // Post columns from the ONE shared constant (ENG-794) — see the note in
    // app/api/horses/[id]/feed/route.ts and on the constant itself. `horse_id`
    // and the embedded horse join are this route's own context and stay here.
    // Pinned exactly by test/trainers-route.test.ts.
    // `horse.photo_url` (ENG-958) is a bare object path in the PRIVATE
    // `horse-photos` bucket, added to this SAME embed — trainer-posts.tsx
    // batch-signs it client-side (this route is a plain BFF read, not the
    // place bytes get minted). Pinned by test/trainers-route.test.ts.
    .select(`${POST_INTRINSIC_COLUMNS}, horse_id, horse:horse_id(display_name, racing_name, photo_url)`)
    .eq("source_trainer_id", id)
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(20);

  return ok(posts ?? []);
}
