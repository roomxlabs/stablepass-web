// /notifications — the member's alert inbox (ENG-957).
//
// THE BUG: `app/(member)/sidebar.tsx` has linked here since the shell was built
// and this route did not exist, so "Notifications" was a live 404 on every
// member screen.
//
// needs-design-check: there is NO web mockup for this screen — `.rx/mockups.md`
// lists none, and mobile records the same gap for its Alerts tab. The design
// reference is mobile's Alerts tab (`src/app/(tabs)/alerts.tsx`), which is
// shipped and signed off; the copy and row behaviour are ported from it and the
// visual values come from `app/globals.css` tokens. Replace this marker if a web
// mockup is ever produced.
//
// Server component: the (member) layout already guards auth, so this resolves
// the entitlement and either walls the screen or hands off to the client inbox.
// The inbox sits behind the same gate as the content its rows open into, which
// is how mobile has it (Alerts lives inside the gated tab group).
import { supabaseServer } from "@/lib/supabase/server";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { AccessWall } from "@/components/access-wall";
import { NotificationsInbox } from "./notifications-inbox";

export const metadata = { title: "Notifications · StablePass" };

export default async function NotificationsPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();

  // Resolved HERE, on the server, and handed down as a BOOLEAN — the wall's copy
  // branches on whether this member has ever paid us, and `stripe_customer_id`
  // must never reach client JS (.rx/guardrails.md #1).
  const { entitled, everSubscribed } = await readSubscriptionState(user!.id);

  if (!entitled) {
    return (
      <div className="page-pad">
        <h1 className="section-title-web">Notifications</h1>
        <AccessWall everSubscribed={everSubscribed} />
      </div>
    );
  }

  return <NotificationsInbox />;
}
