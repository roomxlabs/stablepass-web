// Horses browse (pattern-based — no confirmed mockup for the list itself; the
// grid reuses the W4 `.onboarding-grid-web` skin + `<HorseCard>`, same as
// onboarding). Server component: resolves the signed-in user's id (the (member)
// layout already guards auth) and hands off to the client HorsesGrid, which owns
// the fetch/gate/empty-state loop against supabaseBrowser (RLS-scoped read).
import { supabaseServer } from "@/lib/supabase/server";
import { HorsesGrid } from "./horses-grid";

export const metadata = { title: "Horses · StablePass" };

export default async function HorsesPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();

  return <HorsesGrid viewerId={user!.id} />;
}
