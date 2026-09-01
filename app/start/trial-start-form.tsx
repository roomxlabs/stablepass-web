"use client";

// Trial-start form (client) — first name, last name, email, phone, postcode,
// password. Layout follows mockups/web/screens/03-trial-start.html (ENG-571):
// the name pair and the phone/postcode pair are laid out with the existing
// `.input-row` (flex, gap 12, children flex:1); email and password run full
// width. No new design-system classes.
//
// Deviations from that mockup, both on client instruction (17 Aug 2026), so do
// not reinstate either as a fidelity fix:
//   - the `.trial-banner-web` "30 days, on us" block above the fields is gone;
//     the h1 and sub-heading already say it.
//   - the phone field formats to '+61 400 000 000' as you type and is validated
//     as a real AU number, where the mockup had a plain free-text field.
//
// Posts to the /api/auth/signup BFF route, which does the anon signUp
// server-side and returns the trial envelope; on success the session cookie is
// set and we go to onboarding. The password is only ever sent to our route over
// POST — never logged, never rendered, never put in a query string.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import PasswordInput from "@/components/password-input";

const MIN_PASSWORD = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// AU postcodes are exactly four digits and are stored as text — '0800' (NT) is
// valid, so this must never become a number input or go near parseInt.
const POSTCODE_RE = /^\d{4}$/;

// --- Australian phone numbers -----------------------------------------------
// The field formats as you type into the one shape app_user.phone already
// holds: '+61 400 000 000'. An AU national significant number (NSN) is exactly
// 9 digits — a mobile (4XX XXX XXX) or a landline on area code 2, 3, 7 or 8.
// Leading 1, 5, 6, 9 and 0 are not valid, so 13/1300/1800 service numbers are
// refused on purpose: this field is a person's own contact number.
const AU_NSN_LEN = 9;
const AU_PHONE_RE = /^[2-478]\d{8}$/;
const PHONE_CC = "+61 ";

// Reduce anything a member might type or paste — 0412 345 678, 412345678,
// +61 412 345 678, 0061 412 345 678, brackets, dots and dashes included — to
// those 9 significant digits. Also reports how many leading digits were prefix
// rather than NSN, which is what lets the caret be mapped back afterwards.
// Safe to test '61' before the trunk '0': a real NSN starts 2, 3, 4, 7 or 8,
// so it can never itself begin with 61.
function auParse(input: string): { nsn: string; prefixDigits: number } {
  const digits = input.replace(/\D/g, "");
  let i = 0;
  if (digits.startsWith("0011")) i = 4; // AU international dial-out prefix
  else if (digits.startsWith("00")) i = 2; // generic IDD prefix
  if (digits.slice(i).startsWith("61")) i += 2; // country code
  if (digits.slice(i).startsWith("0")) i += 1; // national trunk '0'
  return { nsn: digits.slice(i, i + AU_NSN_LEN), prefixDigits: i };
}

// Mobiles group 3-3-3, landlines one area digit then 4-4. Both patterns sum to
// AU_NSN_LEN, which is why no digit can fall off the end of the loop.
function auFormat(nsn: string): string {
  if (!nsn) return "";
  const groups = nsn.startsWith("4") ? [3, 3, 3] : [1, 4, 4];
  const parts: string[] = [];
  let i = 0;
  for (const size of groups) {
    if (i >= nsn.length) break;
    parts.push(nsn.slice(i, i + size));
    i += size;
  }
  return PHONE_CC + parts.join(" ");
}

// Character offset that sits just after the nth significant digit. n === 0 means
// 'before the first digit', i.e. immediately after the '+61 ' prefix.
function auCaret(formatted: string, n: number): number {
  if (!formatted) return 0;
  if (n <= 0) return PHONE_CC.length;
  let seen = 0;
  for (let i = PHONE_CC.length; i < formatted.length; i++) {
    if (formatted[i] >= "0" && formatted[i] <= "9") {
      seen += 1;
      if (seen === n) return i + 1;
    }
  }
  return formatted.length;
}

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

  const phoneRef = useRef<HTMLInputElement>(null);
  const phoneCaret = useRef<number | null>(null);

  // The formatter rewrites the phone value on every keystroke, so React resets
  // the input and the browser parks the caret at the end. Put it back where the
  // member was actually editing. No dependency array on purpose: this must also
  // clear a pending offset on the render where the formatted value came out
  // unchanged (a 10th digit being capped), or it would fire on a later edit.
  useEffect(() => {
    const el = phoneRef.current;
    if (el && phoneCaret.current !== null) {
      el.setSelectionRange(phoneCaret.current, phoneCaret.current);
    }
    phoneCaret.current = null;
  });

  function onPhoneChange(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    const caret = e.target.selectionStart ?? raw.length;
    const { nsn, prefixDigits } = auParse(raw);

    let digits = nsn;
    // Which significant digit the caret sits behind, prefix digits discounted.
    let atDigit = Math.min(
      Math.max(raw.slice(0, caret).replace(/\D/g, "").length - prefixDigits, 0),
      digits.length,
    );

    // Deleting a separator leaves the digit count unchanged, so reformatting
    // would put the space straight back and the caret would never move — the
    // field reads as frozen. Take the digit the member meant instead.
    const inputType = (e.nativeEvent as InputEvent).inputType;
    const unchanged = digits === auParse(form.phone).nsn;
    if (unchanged && inputType === "deleteContentBackward" && atDigit > 0) {
      digits = digits.slice(0, atDigit - 1) + digits.slice(atDigit);
      atDigit -= 1;
    } else if (unchanged && inputType === "deleteContentForward" && atDigit < digits.length) {
      digits = digits.slice(0, atDigit) + digits.slice(atDigit + 1);
    }

    // With no significant digits yet the field shows the bare country code, so
    // typing a leading '0' visibly becomes '+61 ' rather than vanishing. A
    // delete still empties it outright — otherwise the caret gets trapped
    // behind a '+61 ' that refuses to go away.
    const deleting = inputType === "deleteContentBackward" || inputType === "deleteContentForward";
    let value: string;
    if (digits) value = auFormat(digits);
    else if (deleting) value = "";
    else value = /\d/.test(raw) ? PHONE_CC : "";

    phoneCaret.current = auCaret(value, atDigit);
    setForm((f) => ({ ...f, phone: value }));
  }

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
    // The field formats as you type, but nothing stops a member submitting a
    // half-typed number, and the route only checks the field is non-empty.
    if (!AU_PHONE_RE.test(auParse(payload.phone).nsn)) {
      setError("Enter a valid Australian phone number, e.g. +61 412 345 678.");
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
    // Branch on the CODE, not the bare 409. The route answers 409 with
    // `trial_already_used` for both a repeat phone and a repeat email, and the
    // wall is the whole point of the response; a status-only test would also
    // swallow any future 409 that means something else entirely.
    //
    // NAVIGATE rather than swapping the wall in locally. The screen's left-hand
    // panel — which pitches the free trial — lives in app/start/page.tsx,
    // OUTSIDE this component, so a local swap would leave the trial pitch sitting
    // beside a message saying the trial is used up. Going to the URL re-renders
    // the whole screen from the server, which also means the JS-blocked path and
    // this one render the exact same markup and cannot drift. `replace`, not
    // `push`: a dead end does not deserve a history entry, and Back should
    // return where the member came from. Left busy-locked on purpose so the
    // button cannot be double-submitted while the navigation is in flight.
    if (body?.error?.code === "trial_already_used") {
      router.replace("/start?trial=used");
      return;
    }
    // No status-409 branch any more. The route's ONLY 409 is
    // `trial_already_used`, handled above, and the copy that used to live here
    // ("That email is already registered") named the credential that matched —
    // exactly what the wall is required not to reveal. Any unexpected 409 now
    // falls through to the generic message rather than to a stale, off-message
    // one that contradicts the ticket.
    if (res.status === 429) setError("Too many attempts — please wait a moment and try again.");
    else setError(body?.error?.message ?? "Please check your details and try again.");
    setBusy(false);
  }

  return (
    <form className="auth-card" onSubmit={onSubmit} noValidate>
      <h1>Start your 30 days free.</h1>
      <p className="auth-sub">A few details to get going. No credit card needed.</p>

      {error && <div className="form-error" role="alert">{error}</div>}

      <div className="input-row">
        <div className="input-group">
          <label className="input-label" htmlFor="first-name">First name</label>
          <input id="first-name" className="input" type="text" autoComplete="given-name"
            placeholder="John" value={form.firstName} onChange={set("firstName")} required />
        </div>
        <div className="input-group">
          <label className="input-label" htmlFor="last-name">Last name</label>
          <input id="last-name" className="input" type="text" autoComplete="family-name"
            placeholder="Smith" value={form.lastName} onChange={set("lastName")} required />
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
          {/* No maxLength, unlike postcode: pasting '0011 61 412 345 678' would
              be truncated before onChange ever saw it. auParse caps the digits
              instead, which cannot corrupt a paste. */}
          <input id="phone" ref={phoneRef} className="input" type="tel" autoComplete="tel"
            placeholder="+61 412 345 678" value={form.phone} onChange={onPhoneChange} required />
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
        <PasswordInput id="password" className="input" autoComplete="new-password"
          placeholder="At least 8 characters" minLength={MIN_PASSWORD}
          value={form.password} onChange={set("password")} required />
      </div>

      <button type="submit" className="btn btn-primary btn-block btn-large" style={{ marginTop: 12 }} disabled={busy}>
        {busy ? "Starting your trial…" : "Start free trial"}
      </button>

      <div className="legal-mini">
        By continuing you agree to our <Link href="/legal/terms">Terms</Link> and{" "}
        <Link href="/legal/privacy">Privacy Policy</Link>.
      </div>

      {/*
        prefetch={false} on THIS link only, deliberately — do not "tidy" it into
        consistency with the two legal links above.

        The asymmetry tracks the route type. `/legal/[slug]` builds as `●`
        (prerendered via generateStaticParams), so prefetching it costs a static
        payload and genuinely speeds up the Terms/Privacy tap. `/signin` builds
        as `ƒ` (dynamic): its server component awaits `supabaseServer()` and then
        `auth.getUser()`, and there is no `loading.tsx` anywhere under `app/` to
        give the prefetch a static shell to stop at. So the default viewport
        prefetch would render the whole page server-side and spend a Supabase
        round-trip on EVERY view of the signup form — the highest-intent page on
        the site — for a navigation most visitors here never make.

        This keeps ENG-598 what it says it is: a lint fix, with no behaviour
        change at the network layer either.
      */}
      <div className="auth-foot">
        Already a member? <Link href="/signin" prefetch={false}>Sign in</Link>
      </div>
    </form>
  );
}
