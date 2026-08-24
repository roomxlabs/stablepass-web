// Trial-start screen (03-trial-start.html). Split-screen: brand/trial quote panel +
// the signup form. Already-signed-in visitors skip to the feed.
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { TrialStartForm } from "./trial-start-form";
import { TrialUsedWall } from "./trial-used-wall";
import { Wordmark } from "@/components/wordmark";

export const metadata = { title: "Start your free trial · StablePass" };

export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<{ trial?: string }>;
}) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (user) redirect("/explore");

  // `/start?trial=used` server-renders the repeat-signup wall (ENG-763).
  //
  // The client path in trial-start-form.tsx flips to the same component after
  // /api/auth/signup answers 409, but that path needs JavaScript, and this
  // screen is reviewed on a phone with scripting blocked — where the form
  // cannot submit at all, so the wall would be unreachable and unreviewable.
  // This gives it a real URL that renders as plain HTML with a working link
  // out. It is a rendering switch and nothing more: it creates no account,
  // reads nothing, and asserts nothing about the visitor, so an arbitrary
  // visitor appending it sees a page inviting them to sign in, which is
  // harmless and true of `/signin` itself.
  const { trial } = await searchParams;
  const trialUsed = trial === "used";

  return (
    <div className="auth-page">
      <aside className="auth-page-side">
        <div className="auth-page-side-logo">
          <Wordmark className="auth-side-brand" />
        </div>
        <div className="auth-side-quote">
          {/* The quote must agree with the panel beside it. The trial pitch
              ("30 days on us, no credit card") next to a wall saying the trial
              is already used reads as a contradiction and undercuts the join
              prompt — the same defect ENG-729 shipped, where a CTA band offered
              the free trial on a page saying you could not join yet. This is
              also WHY the wall is a server-rendered URL rather than a state
              swap inside the form: the aside is outside the form, so an
              in-place swap could only ever change half the screen. */}
          {trialUsed ? (
            <p className="quote">
              &ldquo;Come and join us properly. Every update, every race day report and
              every replay from the yard, straight from the people who know these
              horses.&rdquo;
            </p>
          ) : (
            <p className="quote">
              &ldquo;30 days on us — no credit card, no auto-charge. Just unlock the
              platform and see if it&rsquo;s for you.&rdquo;
            </p>
          )}
          <div className="attrib">
            <div className="attrib-avatar">JA</div>
            <div>Justin Alpar · Founder, stablepass</div>
          </div>
        </div>
        <div className="auth-side-copyright">© Stablepass Pty Ltd</div>
      </aside>

      <main className="auth-page-form">
        {trialUsed ? <TrialUsedWall /> : <TrialStartForm />}
      </main>
    </div>
  );
}
