"use client";

// Forgot-password form (ENG-953). Email in → "check your inbox" out.
//
// The whole screen is built around the no-enumeration rule the BFF enforces:
// `/api/auth/forgot-password` always answers 200 with the same body, so there
// is NOTHING here to branch on. That is deliberate, and it shapes the UI:
//
//   * There is no "we couldn't find that account" state, because we are never
//     told. The sent screen's wording ("If <email> is registered…") is honest
//     about that rather than implying a match.
//   * The only error path is a transport failure — the fetch itself never
//     completing. A non-OK status is treated the same as OK, because the route
//     has no non-OK status to give and inventing UI for one would be dead code
//     that a future reader might "fix" into an enumeration leak.
//
// Layout classes are the sign-in card's, unchanged (02-signin.html).
import { useState } from "react";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Response body intentionally unread — see the note above.
      await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      setError("Couldn't reach StablePass just then. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="auth-card">
        <h1>Check your inbox.</h1>
        {/* "If … is registered" — not "we've sent". The server never told us
            whether the address exists, and the copy must not pretend it did.

            Wording note: this sentence must avoid every phrase in
            `CONFIRMATION_COPY` (`test/marketing-marquee.test.ts`). That
            guardrail sweeps the ENTIRE built output, not just marketing, and an
            earlier draft of this sentence tripped it. Do not quote the banned
            fragments even to explain them — sourcemaps carry comments, so the
            explanation itself fails the sweep. Read the list in that test. */}
        <p className="auth-sub">
          If <strong>{email}</strong> is registered with StablePass, a link to set a new
          password will arrive in your inbox shortly. It expires in an hour.
        </p>
        <p className="auth-sub" style={{ marginBottom: 24 }}>
          Nothing after a few minutes? Check your spam folder, or try again with a
          different address.
        </p>
        <button
          type="button"
          className="btn btn-light btn-block"
          onClick={() => {
            setSent(false);
            setError(null);
          }}
        >
          Use a different email
        </button>
        <div className="auth-foot">
          <a href="/signin">Back to sign in</a>
        </div>
      </div>
    );
  }

  return (
    <form className="auth-card" onSubmit={onSubmit} noValidate>
      <h1>Reset your password.</h1>
      <p className="auth-sub">
        Enter the email you signed up with and we&apos;ll send you a link to set a new
        password.
      </p>

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

      <button
        type="submit"
        className="btn btn-primary btn-block btn-large"
        style={{ marginTop: 12 }}
        disabled={busy}
      >
        {busy ? "Sending…" : "Send reset link"}
      </button>

      <div className="auth-forgot">
        <a href="/signin">Back to sign in</a>
      </div>

      <div className="auth-foot">
        Don&apos;t have an account?{" "}
        <a href="/start">Create an account — 30 days free</a>
      </div>
    </form>
  );
}
