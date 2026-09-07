// Forgot-password screen (ENG-953).
//
// No dedicated mockup exists for this screen. It is built from the confirmed
// auth reference — `mockups/web/screens/02-signin.html` — reusing that shell
// (`.auth-page` / `.auth-page-side` / `.auth-card`) and its existing design
// system classes verbatim. No new CSS class is invented here; per `.rx/mockups.md`
// a screen needing something the system lacks is a design gap to flag, not a
// local invention, and this screen needs nothing the system lacks.
//
// Unlike /signin this does NOT bounce an already-signed-in visitor: arriving
// here while signed in on another tab is a legitimate way to reach a reset, and
// redirecting them to /explore would be a dead end for the person who came from
// the account screen's "forgot password" link.
import { ForgotPasswordForm } from "./forgot-password-form";
import { Wordmark } from "@/components/wordmark";

export const metadata = { title: "Reset your password · StablePass" };

export default function ForgotPasswordPage() {
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
        <ForgotPasswordForm />
      </main>
    </div>
  );
}
