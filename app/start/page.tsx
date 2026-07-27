// Trial-start screen (03-trial-start.html). Split-screen: brand/trial quote panel +
// the signup form. Already-signed-in visitors skip to the feed.
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { TrialStartForm } from "./trial-start-form";

export const metadata = { title: "Start your free trial · StablePass" };

export default async function StartPage() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (user) redirect("/explore");

  return (
    <div className="auth-page">
      <aside className="auth-page-side">
        <div className="auth-page-side-logo">
          <span className="auth-side-brand">stablepass.</span>
        </div>
        <div className="auth-side-quote">
          <p className="quote">
            &ldquo;30 days on us — no credit card, no auto-charge. Just unlock the
            platform and see if it&rsquo;s for you.&rdquo;
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
