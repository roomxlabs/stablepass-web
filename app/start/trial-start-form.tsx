"use client";

// Trial-start form (client) — first name, last name, email, phone, postcode,
// password. Matches mockups/web/screens/03-trial-start.html 1:1 (ENG-571): the
// name pair and the phone/postcode pair are laid out with the existing
// `.input-row` (flex, gap 12, children flex:1); email and password run full
// width. No new design-system classes.
//
// Posts to the /api/auth/signup BFF route, which does the anon signUp
// server-side and returns the trial envelope; on success the session cookie is
// set and we go to onboarding. The password is only ever sent to our route over
// POST — never logged, never rendered, never put in a query string.
import { useState } from "react";
import { useRouter } from "next/navigation";

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// AU postcodes are exactly four digits and are stored as text — '0800' (NT) is
// valid, so this must never become a number input or go near parseInt.
const POSTCODE_RE = /^\d{4}$/;

const EMPTY = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  postcode: "",
  password: "",
};

export function TrialStartForm() {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Trim before validating and before sending: '3000 ' fails the postcode
    // CHECK constraint in the database, and a whitespace-only field is empty.
    const payload = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      postcode: form.postcode.trim(),
      // Not trimmed — spaces are legitimate password characters. Only the
      // emptiness check below looks at the trimmed value.
      password: form.password,
    };

    // Same order as the route, first failure wins.
    if (
      !payload.firstName ||
      !payload.lastName ||
      !payload.email ||
      !payload.phone ||
      !payload.postcode ||
      !payload.password.trim()
    ) {
      setError("All fields are required.");
      return;
    }
    if (!EMAIL_RE.test(payload.email)) {
      setError("Enter a valid email address.");
      return;
    }
    if (!POSTCODE_RE.test(payload.postcode)) {
      setError("Enter a valid 4-digit Australian postcode.");
      return;
    }
    if (payload.password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }

    setBusy(true);
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
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
      <p className="auth-sub">A few details to get going. No credit card needed.</p>

      <div className="trial-banner-web">
        <div className="trial-label">30 days, on us</div>
        <div className="trial-detail">
          When the trial ends, choose to buy 30 days or stop &mdash; nothing happens
          automatically without you. We won&rsquo;t ask for a card until you decide to
          continue, and access never renews on its own.
        </div>
      </div>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="input-row">
        <div className="input-group">
          <label className="input-label" htmlFor="first-name">First name</label>
          <input id="first-name" className="input" type="text" autoComplete="given-name"
            placeholder="Justin" value={form.firstName} onChange={set("firstName")} required />
        </div>
        <div className="input-group">
          <label className="input-label" htmlFor="last-name">Last name</label>
          <input id="last-name" className="input" type="text" autoComplete="family-name"
            placeholder="Alpar" value={form.lastName} onChange={set("lastName")} required />
        </div>
      </div>

      <div className="input-group">
        <label className="input-label" htmlFor="email">Email</label>
        <input id="email" className="input" type="email" autoComplete="email"
          placeholder="you@example.com" value={form.email} onChange={set("email")} required />
      </div>

      <div className="input-row">
        <div className="input-group">
          <label className="input-label" htmlFor="phone">Phone</label>
          <input id="phone" className="input" type="tel" autoComplete="tel"
            placeholder="+61 4xx xxx xxx" value={form.phone} onChange={set("phone")} required />
        </div>
        <div className="input-group">
          <label className="input-label" htmlFor="postcode">Postcode</label>
          {/* text + inputMode, never type="number": a number input eats the
              leading zero of '0800' and adds a spinner. */}
          <input id="postcode" className="input" type="text" inputMode="numeric"
            autoComplete="postal-code" maxLength={4} placeholder="3000"
            value={form.postcode} onChange={set("postcode")} required />
        </div>
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
