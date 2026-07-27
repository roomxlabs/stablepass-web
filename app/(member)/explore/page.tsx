// Explore feed (06-explore.html). Server component: resolves the signed-in
// user's id (the (member) layout already guards auth — see app/(member)/layout.tsx)
// and hands off to the client ExploreFeed, which owns the fetch/enrich/engagement
// loop against the W5 BFF + supabaseBrowser (RLS-gated reads/writes).
import { supabaseServer } from "@/lib/supabase/server";
import { ExploreFeed } from "./explore-feed";

export const metadata = { title: "Explore · StablePass" };

export default async function ExplorePage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();

  return <ExploreFeed viewerId={user!.id} />;
}
