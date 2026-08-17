// Following — the member's followed horses & trainers (avatar rails) + the ranked
// Following feed. Server component: resolves the signed-in user's id (the (member)
// layout guards auth) and hands off to the client FollowingScreen.
import { supabaseServer } from "@/lib/supabase/server";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { FollowingScreen } from "./following-screen";

export const metadata = { title: "Following · StablePass" };

export default async function FollowingPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();

  // ENG-585: resolved HERE, on the server, and handed down as a BOOLEAN — the
  // wall's copy branches on whether this member has ever paid us, and
  // `stripe_customer_id` itself must never reach client JS (.rx/guardrails.md #1).
  const { everSubscribed } = await readSubscriptionState(user!.id);

  return <FollowingScreen viewerId={user!.id} everSubscribed={everSubscribed} />;
}
