"use client";

import { useId, useState, useSyncExternalStore } from "react";

/**
 * The pre-launch waitlist capture form — ENG-726 (W2 of ENG-721).
 *
 * Lives OUTSIDE `sections/` on the `app-screens-carousel.tsx` precedent: it is a
 * client component the sections mount, not a section itself. W3 (ENG-729) mounts
 * it into the hero and the CTA band and sanctions whatever CSS it needs; this
 * ticket ships the component and its behaviour only.
 *
 * It adds NO rule to `marketing.css` (that file is diffed rule-for-rule against
 * the mockup, so a new rule fails a test until W3 sanctions it). Instead it
 * reuses `.field` / `.field label` / `.field input`, which are already in the
 * sheet and already sanctioned — ported with the mockup's contact form and left
 * unused when that form was removed. So this renders correctly today with zero
 * CSS changes. The `wl-*` classes carry no rules; they exist purely as hooks for
 * W3.
 *
 * ── PROGRESSIVE ENHANCEMENT IS THE POINT ─────────────────────────────────────
 * This renders a REAL `<form method="post" action="/api/waitlist">`. With
 * scripting off the browser submits it natively and the route answers 303 back
 * to `/?joined=…`; with scripting on, `onSubmit` intercepts and fetches the same
 * endpoint for an inline answer with no navigation. Justin reviews this site on
 * a phone with JS blocked, so the native path is the load-bearing one, not a
 * fallback nobody exercises.
 *
 * The JSON body is built from `FormData(form)` rather than from React state, so
 * both paths submit byte-identical fields — and so the honeypot is read from the
 * DOM, catching a bot that writes into the input without dispatching the events
 * React listens for.
 *
 * ── KNOWN LIMIT OF THE NO-JS SUCCESS STATE (hand-off to W3) ──────────────────
 * `/` is statically prerendered, and a static page cannot vary on its query
 * string — the same HTML is served for `/` and for `/?joined=1`. So the
 * `joined` state below is recovered CLIENT-SIDE, which means a scripting-off
 * visitor completes the round-trip but lands on the unchanged page.
 *
 * `initialJoined` is the seam that closes that: if W3 mounts this from a server
 * component that reads `searchParams` (which opts `/` into dynamic rendering),
 * passing it through renders the success state in the HTML itself and the no-JS
 * path is complete end to end. That is W3's call to make, because it is W3 that
 * decides whether the marketing home stays static. Deliberately NOT
 * `useSearchParams()`: under static prerendering that hook forces a Suspense
 * bailout, which is the very deopt this note is trying to leave as a choice.
 */

/** Mirrors the route's answers so the two never drift apart in copy. */
const MESSAGES = {
  success: "You're on the list. We'll email you the moment we open.",
  email: "Enter a valid email address.",
  server: "Something went wrong. Please try again.",
} as const;

type Status = "idle" | "submitting" | "success" | "error";

/**
 * The honeypot's name. NOT `company`, which is what the ticket and the epic spec
 * suggested.
 *
 * `name="company"` next to a `Company` label is Chrome Autofill's canonical
 * COMPANY_NAME shape, and Chrome deliberately ignores `autocomplete="off"` for
 * address-profile autofill — so accepting a suggestion in the email field
 * (same profile section) can fill the decoy too. That would silently discard a
 * REAL signup: the route drops the submission and still answers "You're on the
 * list", with nothing logged and a retry reproducing it. For a feature whose
 * entire value is capturing the address, an undetectable silent-drop path is a
 * worse failure than letting a bot through.
 *
 * A neutral name with no autofill semantics avoids the classification entirely.
 * The route still honours `company` as well, so the ticket's stated contract
 * remains true for any caller built against it.
 */
const HONEYPOT_FIELD = "hp_ref";

/**
 * Off-screen, applied to the INPUT itself rather than a wrapper.
 *
 * A wrapper that merely clips still leaves the input with a normal bounding box,
 * which is exactly what autofill's visibility heuristic looks at. Positioning
 * the field itself far off-screen is the classic honeypot placement and is
 * skipped by autofill while still being present for a naive bot that fills
 * every input it parses.
 *
 * Inline rather than a class because `marketing.css` is diffed rule-for-rule
 * against the mockup and this ticket may not add a rule to it.
 */
const OFFSCREEN = {
  position: "absolute",
  left: -9999,
  top: "auto",
  width: 1,
  height: 1,
  opacity: 0,
  overflow: "hidden",
} as const;

export type WaitlistFormProps = {
  /**
   * Server-supplied `?joined=` value, when whoever mounts this can read it
   * server-side. `"1"` renders the success state in the HTML — the only way a
   * scripting-off visitor can see it. See the note above.
   */
  initialJoined?: string | null;
  /** Server-supplied `?reason=`, paired with `initialJoined === "0"`. */
  initialReason?: string | null;
};

/** Map a `?joined=`/`?reason=` pair onto the state it represents. */
function stateFromQuery(
  joined: string | null | undefined,
  reason: string | null | undefined,
): { status: Status; message: string } | null {
  if (joined === "1") return { status: "success", message: MESSAGES.success };
  if (joined === "0") {
    return { status: "error", message: reason === "email" ? MESSAGES.email : MESSAGES.server };
  }
  return null;
}

/**
 * Read one query parameter from the LIVE browser URL, safely across the
 * server/client boundary.
 *
 * `useSyncExternalStore` rather than a mount effect that calls setState. The
 * server snapshot is `null`, so the first client render matches the server HTML
 * byte for byte and there is no hydration mismatch — this route group has
 * already been bitten by one (see the `.js` flag note in `.rx/gotchas.md`).
 * React then re-renders with the client snapshot.
 *
 * `subscribe` is a no-op returning a no-op: this reads the LANDING url, which
 * cannot change under us without a navigation that remounts the component. The
 * snapshot returns a string or null — a primitive — so React's "getSnapshot
 * should be cached" check is satisfied by value equality.
 */
const NEVER_CHANGES = () => () => {};
const SERVER_SNAPSHOT = () => null;

function useQueryParam(name: string): string | null {
  return useSyncExternalStore(
    NEVER_CHANGES,
    () => new URLSearchParams(window.location.search).get(name),
    SERVER_SNAPSHOT,
  );
}

export default function WaitlistForm({ initialJoined, initialReason }: WaitlistFormProps = {}) {
  const emailId = useId();

  /**
   * What THIS submission did, once the visitor has submitted in-page. `null`
   * until then, which is what lets the URL-derived state below show through
   * after a native round-trip — and what stops it clobbering an inline result
   * afterwards.
   */
  const [submitted, setSubmitted] = useState<{ status: Status; message: string } | null>(null);

  // Server-supplied first (the only form a scripting-off visitor can see), then
  // the live browser URL. Both are DERIVED during render — neither is copied
  // into state, so there is nothing to keep in sync.
  const urlJoined = useQueryParam("joined");
  const urlReason = useQueryParam("reason");
  const fromQuery =
    stateFromQuery(initialJoined, initialReason) ?? stateFromQuery(urlJoined, urlReason);

  const { status, message } = submitted ?? fromQuery ?? { status: "idle" as Status, message: "" };

  const submitting = status === "submitting";

  /**
   * Replace the fields with the confirmation ONLY for an inline submit.
   *
   * Deliberately not for the URL-derived success. `?joined=1` persists across a
   * reload, a back-navigation and a shared link, so keying the swap off it would
   * leave `stablepass.co/?joined=1` showing a form with no input and no submit
   * button — permanently, to anyone who opened that link, whether or not they
   * ever joined. The inline case has no such persistence: it is scoped to this
   * page view, where hiding an armed submit button genuinely does prevent a
   * second identical POST.
   */
  const joinedInline = submitted?.status === "success";
  const succeeded = status === "success";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    // Read the fields off the form itself, not off React state — see the note
    // about the honeypot at the top of this file.
    const data = new FormData(event.currentTarget);
    const payload = {
      email: String(data.get("email") ?? ""),
      [HONEYPOT_FIELD]: String(data.get(HONEYPOT_FIELD) ?? ""),
    };

    setSubmitted({ status: "submitting", message: "" });

    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        // `accept` is what selects the JSON envelope over the 303 branch. The
        // route negotiates on it, so it is required, not habit.
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        setSubmitted({ status: "success", message: MESSAGES.success });
        return;
      }

      const body = await response.json().catch(() => null);
      const code = body?.error?.code;
      setSubmitted({
        status: "error",
        message: code === "invalid_email" ? MESSAGES.email : MESSAGES.server,
      });
    } catch {
      // Offline, DNS, a blocked request — never a reason to lose what they typed.
      setSubmitted({ status: "error", message: MESSAGES.server });
    }
  }

  return (
    <form
      className="wl-form"
      method="post"
      action="/api/waitlist"
      onSubmit={onSubmit}
      aria-describedby={`${emailId}-status`}
    >
      {!joinedInline && (
        <>
          {/* `.field` is an existing, already-sanctioned marketing rule — see
              the note at the top. No new CSS ships with this ticket. */}
          <div className="field wl-field">
            <label htmlFor={emailId}>Email address</label>
            {/* UNCONTROLLED on purpose. The submit path reads FormData, so React
                state would be a second copy of the value that nothing consumes —
                and a controlled input clobbers anything typed before hydration
                with its own empty `value`, which on a slow phone is a real way to
                lose a keystroke. Leaving the DOM to own it also means the typed
                address survives an error render for free. */}
            <input
              id={emailId}
              className="wl-input"
              type="email"
              name="email"
              placeholder="you@example.com"
              autoComplete="email"
              maxLength={254}
              required
              disabled={submitting}
              aria-invalid={status === "error" || undefined}
            />
          </div>

          {/* The honeypot. No label and a semantically neutral name, so browser
              autofill never classifies it; positioned off-screen on the input
              itself, so autofill's visibility check skips it; out of the tab
              order. A submission that fills it is a bot, and the route answers
              those with the ordinary success body and writes nothing. This is
              the ONLY abuse control in v1 (rate limiting was scoped out), so it
              is not decoration. */}
          <div aria-hidden="true">
            <input
              id={`${emailId}-hp`}
              type="text"
              name={HONEYPOT_FIELD}
              defaultValue=""
              tabIndex={-1}
              autoComplete="off"
              style={OFFSCREEN}
            />
          </div>

          <button className="btn btn-green wl-submit" type="submit" disabled={submitting}>
            {submitting ? "Joining…" : "Join the waitlist"}
          </button>
        </>
      )}

      {/* Always in the DOM, even when empty. A live region that is inserted at
          the same moment as its text is frequently not announced at all —
          screen readers watch a region they already know about. */}
      <p
        id={`${emailId}-status`}
        className={message ? `wl-msg wl-msg-${succeeded ? "success" : "error"}` : "wl-msg"}
        role="status"
        aria-live="polite"
      >
        {message}
      </p>
    </form>
  );
}
