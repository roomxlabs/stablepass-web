// Trainers browse (pattern-based, no mockup — W8). Server shell resolves the
// viewer; the client grid does the gated RLS-scoped read. Mirrors the W7 horses
// browse page.
import { supabaseServer } from "@/lib/supabase/server";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { TrainersGrid } from "./trainers-grid";

export const metadata = { title: "Trainers · StablePass" };

export default async function TrainersPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();

  // ENG-585: resolved HERE, on the server, and handed down as a BOOLEAN — the
  // wall's copy branches on whether this member has ever paid us, and
  // `stripe_customer_id` itself must never reach client JS (.rx/guardrails.md #1).
  const { everSubscribed } = await readSubscriptionState(user!.id);
  return <TrainersGrid viewerId={user!.id} everSubscribed={everSubscribed} />;
}
