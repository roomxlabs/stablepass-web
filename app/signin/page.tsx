// Sign-in screen (02-signin.html). Split-screen: brand/quote panel + the form.
// Already-signed-in visitors skip straight to the feed.
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { SignInForm } from "./sign-in-form";
import { Wordmark } from "@/components/wordmark";

export const metadata = { title: "Sign in · StablePass" };

export default async function SignInPage() {
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
          <p className="quote">
            &ldquo;For the first time, you can be on the inside — closer to the horse
            than a race-day membership ever got you.&rdquo;
          </p>
          <div className="attrib">
            <div className="attrib-avatar">JA</div>
            <div>Justin Alpar · Founder, stablepass</div>
          </div>
        </div>
        <div className="auth-side-copyright">© Stablepass Pty Ltd</div>
      </aside>

      <main className="auth-page-form">
        <SignInForm />
      </main>
    </div>
  );
}
