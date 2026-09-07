// Reset-password screen (ENG-953) — the landing page for a Supabase recovery
// link. This is the URL the mobile app already sends people to
// (`app.stablepass.co/reset-password`, mobile `lib/auth.ts:69`) and the URL the
// BFF's `redirectTo` points at, so its path is a fixed contract with two other
// callers: it cannot be renamed or moved without breaking links already sitting
// in members' inboxes.
//
// Built from the confirmed auth reference `mockups/web/screens/02-signin.html`
// (no dedicated mockup exists for this screen — see the PR body). Shell and
// classes are the sign-in card's, unchanged.
//
// ── States, all decided server-side ────────────────────────────────────────
//
//   1. a recovery secret is in the URL → hand it to `confirm/route.ts`, the only
//      place that can write cookies, then return to a clean URL. The secret is
//      never in the address bar of the form.
//   2. a RECOVERY-VERIFIED visitor → the new-password form.
//   3. link opened on the wrong device → advice that can actually be acted on.
//   4. anything else → the expired/invalid message plus a way to get a new link.
//
// STATE 2 IS A SECURITY BOUNDARY, NOT A CONVENIENCE. It deliberately requires
// the marker cookie from `confirm/route.ts` and NOT merely `getUser()`. Gating
// on "is someone signed in" makes this a change-password screen that never asks
// for the current password: all three reviewers reproduced a plain
// password-login session silently taking over an account through it, and
// because a new sign-in revokes other sessions (guardrail #5) the real member is
// locked out with no notification. The product's chosen change-password path is
// the email-verified one — `app/(member)/account/account-forms.tsx:162` sends
// members to `/forgot-password` precisely so the change is email-verified. This
// page must not quietly offer a way around that.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { ResetPasswordForm } from "./reset-password-form";
import { RECOVERY_COOKIE } from "./recovery-cookie";
import { Wordmark } from "@/components/wordmark";

// Neutral on purpose: this one title covers the form, the expired screen and
// the wrong-device screen, and promising "Set a new password" on a dead link
// reads as a broken page.
export const metadata = { title: "Password reset · StablePass" };

// Next 15+: searchParams is async.
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const one = (v: string | string[] | undefined): string | null =>
  typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;

function AuthShell({ children }: { children: React.ReactNode }) {
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
      <main className="auth-page-form">{children}</main>
    </div>
  );
}

/** State 4 — and the fallback for every unexpected combination. */
function ExpiredCard() {
  return (
    <div className="auth-card">
      <h1>This link has expired.</h1>
      <p className="auth-sub">
        Password reset links are single-use and only last an hour. Request a fresh
        one and we&apos;ll email it straight over.
      </p>
      <a
        href="/forgot-password"
        className="btn btn-primary btn-block btn-large"
        style={{ marginTop: 12 }}
      >
        Send me a new link
      </a>
      <div className="auth-forgot">
        <a href="/signin">Back to sign in</a>
      </div>
    </div>
  );
}

/**
 * State 3 — the link is genuine but was opened somewhere it cannot be spent.
 *
 * Worth its own screen: telling this member the link "expired" sends them to
 * request another, which fails the same way, forever. The honest instruction is
 * the only thing that gets them out.
 */
function WrongDeviceCard() {
  return (
    <div className="auth-card">
      <h1>Open this link where you asked for it.</h1>
      <p className="auth-sub">
        For your security this reset link can only be completed in the same browser
        that requested it. If you asked for it on another device, open the email
        there — or request a fresh link here and finish on this one.
      </p>
      <a
        href="/forgot-password"
        className="btn btn-primary btn-block btn-large"
        style={{ marginTop: 12 }}
      >
        Send a new link to this device
      </a>
      <div className="auth-forgot">
        <a href="/signin">Back to sign in</a>
      </div>
    </div>
  );
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const code = one(params.code);
  const tokenHash = one(params.token_hash);
  const type = one(params.type);
  const state = one(params.state);
  const errorParam = one(params.error) ?? one(params.error_code);

  // State 1 — a secret arrived. Forward only the parameters the confirm handler
  // understands, and let it own the exchange.
  if (!errorParam && (code || (tokenHash && type === "recovery"))) {
    const qs = new URLSearchParams();
    if (code) qs.set("code", code);
    if (tokenHash) qs.set("token_hash", tokenHash);
    if (type) qs.set("type", type);
    redirect(`/reset-password/confirm?${qs.toString()}`);
  }

  if (state === "devicemismatch") {
    return (
      <AuthShell>
        <WrongDeviceCard />
      </AuthShell>
    );
  }

  if (!errorParam && state !== "invalid") {
    // THE GATE. A session alone is not enough — see the header note.
    const jar = await cookies();
    const recoveryVerified = jar.get(RECOVERY_COOKIE)?.value === "1";

    if (recoveryVerified) {
      const sb = await supabaseServer();
      const { data: { user } } = await sb.auth.getUser();
      // State 2 — recovery-verified AND a live session.
      if (user) {
        return (
          <AuthShell>
            <ResetPasswordForm email={user.email ?? null} />
          </AuthShell>
        );
      }
    }
  }

  return (
    <AuthShell>
      <ExpiredCard />
    </AuthShell>
  );
}
