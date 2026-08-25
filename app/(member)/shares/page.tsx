// Shares — for-sale-horse posts only (ENG-831). Server component: resolves the
// signed-in user id (the (member) layout guards auth) and hands off to the
// client SharesFeed. needs-design-check: no Shares mockup; reuses Explore layout.
import { supabaseServer } from "@/lib/supabase/server";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { SharesFeed } from "./shares-feed";

export const metadata = { title: "Shares · StablePass" };

export default async function SharesPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();

  const { everSubscribed } = await readSubscriptionState(user!.id);

  return <SharesFeed viewerId={user!.id} everSubscribed={everSubscribed} />;
}
