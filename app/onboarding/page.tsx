// Onboarding — "Build your stable" (05-onboarding.html). A full-page, sidebar-less
// step shown right after signup, so it lives at /onboarding (NOT under the
// app/(member) sidebar shell — Next layouts always nest, and the mockup has no
// sidebar). Own auth guard + content gate; horses are a gated, RLS-scoped read.
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { AccessWall } from "@/components/access-wall";
import { HorsePicker, type PickHorse } from "./horse-picker";
import { Wordmark } from "@/components/wordmark";

export const metadata = { title: "Build your stable · StablePass" };

type HorseRow = { id: string; display_name: string; trainer: { name: string } | { name: string }[] | null };

export default async function OnboardingPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/signin");

  const [{ data: profile }, subscription] = await Promise.all([
    sb.from("app_user").select("name,email").eq("id", user.id).maybeSingle(),
    readSubscriptionState(user.id),
  ]);

  const firstName = (profile?.name?.trim() || profile?.email?.split("@")[0] || "there").split(" ")[0];
  // ENG-585: this used to be `status === "trial" || status === "active"`, on a
  // select that did not even fetch the dates. An `active` member whose pass
  // expired therefore counted as having access, ran the horse query, got
  // nothing back (RLS correctly denies them) and was shown "No horses yet." —
  // a stranger's empty-stable message instead of an explanation.
  //
  // Note the direction of this change: `hasAccess()` is STRICTLY STRICTER than
  // the status test it replaces (identical for lapsed/canceled/entitled rows,
  // and it additionally catches the expired ones). It can only ever show the
  // wall to more people, never content to more people — no access behaviour
  // moves, which is the guardrail on this ticket.
  const { entitled, everSubscribed } = subscription;

  // Content-gated read: RLS already returns nothing without access, but detect it
  // explicitly so we can show the wall rather than an empty grid.
  const { data: horseRows } = entitled
    ? await sb
        .from("horse")
        .select("id, display_name, trainer:trainer_id(name)")
        .eq("status", "active")
        .order("display_name")
    : { data: null };

  const horses: PickHorse[] = ((horseRows ?? []) as HorseRow[]).map((h) => {
    const t = Array.isArray(h.trainer) ? h.trainer[0] : h.trainer;
    return { id: h.id, name: h.display_name, trainer: t?.name ?? "Stablepass trainer" };
  });

  return (
    <>
      <nav className="onboarding-nav">
        <Wordmark className="brand" />
        <span className="welcome">Welcome, {firstName} · 30 days free</span>
      </nav>

      <div className="onboarding-web">
        <div className="onboarding-container">
          {!entitled ? (
            <AccessWall everSubscribed={everSubscribed} variant="hero" />
          ) : horses.length === 0 ? (
            <div className="onboarding-empty">
              <h1 className="onboarding-h">No horses yet.</h1>
              <p className="onboarding-sub">Trainers are still setting up their stables — check back shortly.</p>
              <a className="btn btn-ghost btn-large" href="/explore">Skip for now</a>
            </div>
          ) : (
            <HorsePicker horses={horses} userId={user.id} />
          )}
        </div>
      </div>
    </>
  );
}
