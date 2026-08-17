"use client";

// Sign-in form (client) — email/password + Continue with Google. Matches
// mockups/web/screens/02-signin.html, with Apple + Facebook dropped for v1 (W1).
// Auth runs through the Supabase Auth SDK (browser anon client); tokens are set as
// httpOnly cookies by @supabase/ssr — never read into JS here.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

const GoogleMark = () => (
  <svg className="google-icon" viewBox="0 0 18 18" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
    <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
  </svg>
);

export function SignInForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const sb = supabaseBrowser();
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      setError("That email and password didn't match. Please try again.");
      setBusy(false);
      return;
    }
    router.push("/explore");
    router.refresh();
  }

  async function onGoogle() {
    setError(null);
    setBusy(true);
    const sb = supabaseBrowser();
    const { error } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/explore` },
    });
    if (error) {
      setError("Couldn't start Google sign-in. Please try again.");
      setBusy(false);
    }
    // On success the browser is redirected to Google, then back to /auth/callback.
  }

  return (
    <form className="auth-card" onSubmit={onSubmit} noValidate>
      <h1>Welcome back.</h1>
      <p className="auth-sub">Sign in to pick up where you left off.</p>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="input-group">
        <label className="input-label" htmlFor="email">Email</label>
        <input
          id="email"
          className="input"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="input-group">
        <label className="input-label" htmlFor="password">Password</label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>

      <button type="submit" className="btn btn-primary btn-block btn-large" style={{ marginTop: 12 }} disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>

      <div className="auth-divider">
        <div className="rule" />
        <span>or continue with</span>
        <div className="rule" />
      </div>

      <button type="button" className="btn btn-light btn-block" onClick={onGoogle} disabled={busy}>
        <GoogleMark /> Continue with Google
      </button>

      <div className="auth-forgot">
        <a href="/forgot-password">Forgot your password?</a>
      </div>

      {/* Sits directly under "Forgot your password?", so the reader here is often
          someone who already HAS an account and cannot get in. Lead with the fact
          that this creates a NEW account — the old "Not subscribed yet? Start 30
          days free" read as a way back in and produced duplicate accounts. */}
      <div className="auth-foot">
        Don&apos;t have an account?{" "}
        <a href="/start">Create an account — 30 days free</a>
      </div>
    </form>
  );
}
