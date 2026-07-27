"use client";

// Trial-start form (client) — name, email, phone, password. Matches
// mockups/web/screens/03-trial-start.html with a Password field added (W2; the
// mockup omits it). Posts to the /api/auth/signup BFF route, which does the anon
// signUp server-side and returns the trial envelope; on success the session cookie
// is set and we go to onboarding. The password is only ever sent to our route over
// POST — never logged, never rendered.
import { useState } from "react";
import { useRouter } from "next/navigation";

const MIN_PASSWORD = 8;

export function TrialStartForm() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", phone: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (form.password.length < MIN_PASSWORD) {
      setError(`Choose a password of at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setBusy(true);
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form),
    });
    if (res.status === 201) {
      router.push("/onboarding");
      router.refresh();
      return;
    }
    const body = await res.json().catch(() => null);
    if (res.status === 409) setError("That email is already registered. Try signing in instead.");
    else if (res.status === 429) setError("Too many attempts — please wait a moment and try again.");
    else setError(body?.error?.message ?? "Please check your details and try again.");
    setBusy(false);
  }

  return (
    <form className="auth-card" onSubmit={onSubmit} noValidate>
      <h1>Start your 30 days free.</h1>
      <p className="auth-sub">Four details to get going. No credit card needed.</p>

      <div className="trial-banner-web">
        <div className="trial-label">30 days, on us</div>
        <div className="trial-detail">
          When the trial ends, choose to subscribe or stop — nothing happens automatically
          without you. We won&rsquo;t ask for a card until you decide to continue.
        </div>
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="input-group">
        <label className="input-label" htmlFor="name">Your name</label>
        <input id="name" className="input" type="text" autoComplete="name"
          placeholder="Justin Alpar" value={form.name} onChange={set("name")} required />
      </div>
      <div className="input-group">
        <label className="input-label" htmlFor="email">Email</label>
        <input id="email" className="input" type="email" autoComplete="email"
          placeholder="you@example.com" value={form.email} onChange={set("email")} required />
      </div>
      <div className="input-group">
        <label className="input-label" htmlFor="phone">Phone</label>
        <input id="phone" className="input" type="tel" autoComplete="tel"
          placeholder="+61 4xx xxx xxx" value={form.phone} onChange={set("phone")} required />
      </div>
      <div className="input-group">
        <label className="input-label" htmlFor="password">Password</label>
        <input id="password" className="input" type="password" autoComplete="new-password"
          placeholder="At least 8 characters" minLength={MIN_PASSWORD}
          value={form.password} onChange={set("password")} required />
      </div>

      <button type="submit" className="btn btn-primary btn-block btn-large" style={{ marginTop: 12 }} disabled={busy}>
        {busy ? "Starting your trial…" : "Start free trial"}
      </button>

      <div className="legal-mini">
        By continuing you agree to our <a href="/legal/terms">Terms</a> and{" "}
        <a href="/legal/privacy">Privacy Policy</a>.
      </div>

      <div className="auth-foot">
        Already a member? <a href="/signin">Sign in</a>
      </div>
    </form>
  );
}
