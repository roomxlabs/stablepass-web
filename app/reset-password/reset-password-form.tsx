"use client";

// New-password form (ENG-953). Only ever rendered for a visitor the SERVER has
// established a RECOVERY-VERIFIED session for — `confirm/route.ts` exchanged
// their link and set the marker cookie that `page.tsx` requires. Being merely
// signed in is deliberately not enough; see the note in `page.tsx`.
//
// This component never sees, holds, or forwards the recovery secret: by the
// time it mounts the secret is spent and stripped from the URL.
//
// ON GUARDRAIL #1, ACCURATELY. `updateUser` runs on the browser client, which
// reads the Supabase session from `document.cookie` — the `@supabase/ssr`
// cookie is NOT httpOnly, and it carries the access token. That is pre-existing
// and app-wide (every `supabaseBrowser()` caller depends on it), not something
// this screen introduces, but it does mean guardrail #1's "tokens live in
// httpOnly cookies" is not literally true of this repo today. Do not write a
// comment here claiming otherwise — an earlier draft of this file did, and a
// one-line `curl` disproved it. Reconciling the guardrail's wording with the
// architecture is its own ticket.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import PasswordInput from "@/components/password-input";

// Matches the signup route's rule (`app/api/auth/signup/route.ts`). Kept
// identical on purpose: a password this screen accepts must be one the signup
// path would have accepted, or members hit a rule they have never been shown.
const MIN_PASSWORD = 8;

export function ResetPasswordForm({ email }: { email: string | null }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Length is judged on the RAW value, never a trimmed one: leading and
    // trailing spaces are legitimate password characters and trimming here
    // would silently accept a password the member cannot then type back.
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("Those passwords don't match. Please re-enter them.");
      return;
    }

    setBusy(true);
    const sb = supabaseBrowser();
    const { error: updateError } = await sb.auth.updateUser({ password });
    if (updateError) {
      // The common real cause here is a session that expired between the link
      // being opened and the form being submitted.
      setError("We couldn't set that password. Your link may have expired — request a new one.");
      setBusy(false);
      return;
    }

    // The exchange already signed them in, so there is nothing further to do
    // but send them where a signed-in member belongs.
    router.push("/explore");
    router.refresh();
  }

  return (
    <form className="auth-card" onSubmit={onSubmit} noValidate>
      <h1>Set a new password.</h1>
      <p className="auth-sub">
        {email
          ? `Choose a new password for ${email}. You'll be signed in straight after.`
          : "Choose a new password. You'll be signed in straight after."}
      </p>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="input-group">
        <label className="input-label" htmlFor="password">New password</label>
        <PasswordInput
          id="password"
          className="input"
          autoComplete="new-password"
          placeholder="••••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <div className="input-group">
        <label className="input-label" htmlFor="confirm">Confirm new password</label>
        <PasswordInput
          id="confirm"
          className="input"
          autoComplete="new-password"
          placeholder="••••••••••"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </div>

      <button
        type="submit"
        className="btn btn-primary btn-block btn-large"
        style={{ marginTop: 12 }}
        disabled={busy}
      >
        {busy ? "Saving…" : "Save new password"}
      </button>

      <div className="auth-forgot">
        <a href="/signin">Back to sign in</a>
      </div>
    </form>
  );
}
