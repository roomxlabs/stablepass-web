// Trainers browse (pattern-based, no mockup — W8). Server shell resolves the
// viewer; the client grid does the gated RLS-scoped read. Mirrors the W7 horses
// browse page.
import { supabaseServer } from "@/lib/supabase/server";
import { TrainersGrid } from "./trainers-grid";

export const metadata = { title: "Trainers · StablePass" };

export default async function TrainersPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  return <TrainersGrid viewerId={user!.id} />;
}
