// Shares — the LIST of for-sale horses (ENG-956), not a feed. R8 folded shares
// POSTS into the main feed, so this screen is now the only place that lists
// horses with `shares_for_sale = true` as such; it mirrors mobile's Shares tab.
//
// needs-design-check: there is NO web mockup for Shares — `.rx/mockups.md` lists
// no such screen. The design reference is stablepass-mobile's Shares tab
// (`src/app/(tabs)/feed.tsx` segment `shares` -> `HorsesList filter="shares"` +
// `src/components/shares-disclaimer.tsx`), which is shipped and signed off; the
// row is a port of mobile's `src/components/horse-row.tsx`. Replace this marker
// if a web mockup is ever produced.
//
// Server component: resolves the signed-in user id (the (member) layout guards
// auth) and hands off to the client SharesList.
import { supabaseServer } from "@/lib/supabase/server";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { SharesList } from "./shares-list";

export const metadata = { title: "Shares · StablePass" };

export default async function SharesPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();

  // Resolved HERE, on the server, and handed down as a BOOLEAN — the wall's copy
  // branches on whether this member has ever paid us, and `stripe_customer_id`
  // must never reach client JS (.rx/guardrails.md #1).
  const { everSubscribed } = await readSubscriptionState(user!.id);

  return <SharesList viewerId={user!.id} everSubscribed={everSubscribed} />;
}
