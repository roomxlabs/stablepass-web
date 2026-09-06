// Account-creation screen (03-trial-start.html). Split-screen: brand/quote panel
// + the signup form. Already-signed-in visitors skip to the feed.
//
// ENG-1003 removed the free trial from the funnel. There is now exactly ONE
// state on this screen — the form — so the `?trial=used` server-rendered wall,
// its `searchParams` handling and the paired quote switch are all gone. The
// hazard that switch existed to manage is gone with it: the aside sits OUTSIDE
// the form, so any state the form could show had to be mirrored here by hand.
// Keep it that way. If a second state ever comes back, it belongs at a URL, not
// as a swap inside the form, or the two halves of the screen will drift apart.
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { TrialStartForm } from "./trial-start-form";
import { Wordmark } from "@/components/wordmark";

export const metadata = { title: "Create your account · StablePass" };

export default async function StartPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (user) redirect("/explore");

  return (
    <div className="auth-page">
      <aside className="auth-page-side">
        <div className="auth-page-side-logo">
          <Wordmark className="auth-side-brand" />
        </div>
        <div className="auth-side-quote">
          {/* Kept SHORT on purpose (11 words, against the 26 it replaces). This
              column has no mobile breakpoint and clips badly on a phone
              (pre-existing, see .rx/gotchas.md), where the quote wraps to
              roughly one word per line — so length here is a fidelity cost, not
              a copy preference. It also must not pitch anything the funnel no
              longer offers: the trial is retired and the price the member
              actually pays is quoted at /checkout, from Stripe. */}
          <p className="quote">
            &ldquo;Every update, every race day report, every replay from the yard.&rdquo;
          </p>
          <div className="attrib">
            <div className="attrib-avatar">JA</div>
            <div>Justin Alpar · Founder, stablepass</div>
          </div>
        </div>
        <div className="auth-side-copyright">© Stablepass Pty Ltd</div>
      </aside>

      <main className="auth-page-form">
        <TrialStartForm />
      </main>
    </div>
  );
}
