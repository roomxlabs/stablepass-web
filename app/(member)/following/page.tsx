// Following — the member's followed horses & trainers (avatar rails) + the ranked
// Following feed. Server component: resolves the signed-in user's id (the (member)
// layout guards auth) and hands off to the client FollowingScreen.
import { supabaseServer } from "@/lib/supabase/server";
import { FollowingScreen } from "./following-screen";

export const metadata = { title: "Following · StablePass" };

export default async function FollowingPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();

  return <FollowingScreen viewerId={user!.id} />;
}
