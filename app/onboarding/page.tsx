// Onboarding — "Build your stable" (05-onboarding.html). A full-page, sidebar-less
// step shown right after signup, so it lives at /onboarding (NOT under the
// app/(member) sidebar shell — Next layouts always nest, and the mockup has no
// sidebar). Own auth guard + content gate; horses are a gated, RLS-scoped read.
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { HorsePicker, type PickHorse } from "./horse-picker";
import { Wordmark } from "@/components/wordmark";

export const metadata = { title: "Build your stable · StablePass" };

type HorseRow = { id: string; display_name: string; trainer: { name: string } | { name: string }[] | null };

export default async function OnboardingPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/signin");

  const [{ data: profile }, { data: subscription }] = await Promise.all([
    sb.from("app_user").select("name,email").eq("id", user.id).maybeSingle(),
    sb.from("subscription").select("status").eq("user_id", user.id).maybeSingle(),
  ]);

  const firstName = (profile?.name?.trim() || profile?.email?.split("@")[0] || "there").split(" ")[0];
  const hasAccess = subscription?.status === "trial" || subscription?.status === "active";

  // Content-gated read: RLS already returns nothing without access, but detect it
  // explicitly so we can prompt to reactivate rather than show an empty grid.
  const { data: horseRows } = hasAccess
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
          {!hasAccess ? (
            <div className="onboarding-empty">
              <h1 className="onboarding-h">Your trial has ended.</h1>
              <p className="onboarding-sub">Reactivate your subscription to keep following the horses you love.</p>
              <a className="btn btn-primary btn-large" href="/checkout">Reactivate</a>
            </div>
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
