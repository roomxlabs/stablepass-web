"use client";

import { useId, useState, useSyncExternalStore } from "react";

/**
 * The pre-launch waitlist capture form — ENG-726 (W2 of ENG-721).
 *
 * Lives OUTSIDE `sections/` on the `app-screens-carousel.tsx` precedent: it is a
 * client component the sections mount, not a section itself. W3 (ENG-729) mounts
 * it into the hero and the CTA band and sanctions whatever CSS it needs; this
 * ticket ships the component and its behaviour only. Every class name below is
 * either one that already exists in `marketing.css` (`btn`, `btn-green`) or a
 * `wl-*` hook W3 will style — no rule is added to that stylesheet here, because
 * it is diffed rule-for-rule against the mockup.
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
 * Off-screen but still announced. Inline rather than a class because
 * `marketing.css` is diffed rule-for-rule against the mockup and this ticket may
 * not add a rule to it; the same reason the honeypot is hidden this way.
 */
const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
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
 * React then re-renders with the client snapshot. Doing it with an effect works
 * too, but it is a cascading render that `react-hooks/set-state-in-effect`
 * rightly flags, and the derived-value form below is simply the honest shape of
 * this: the state is DERIVED from the URL, never owned.
 *
 * `subscribe` is a no-op returning a no-op: this reads the LANDING url, which
 * cannot change under us without a navigation that remounts the component.
 * The snapshot returns a string or null — a primitive — so React's
 * "getSnapshot should be cached" check is satisfied by value equality.
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
  const [email, setEmail] = useState("");
  const emailId = useId();

  /**
   * What THIS submission did, once the visitor has submitted in-page. `null`
   * until then, which is what lets the URL-derived state below show through
   * after a native round-trip — and what stops it clobbering an inline result
   * afterwards. One nullable piece of state instead of two that must be kept
   * consistent with each other.
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

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "submitting") return;

    // Read the fields off the form itself, not off React state — see the note
    // about the honeypot at the top of this file.
    const data = new FormData(event.currentTarget);
    const payload = {
      email: String(data.get("email") ?? ""),
      company: String(data.get("company") ?? ""),
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

  const submitting = status === "submitting";
  const joined = status === "success";

  return (
    <form
      className="wl-form"
      method="post"
      action="/api/waitlist"
      onSubmit={onSubmit}
      aria-describedby={`${emailId}-status`}
    >
      {/* The success state replaces the fields: there is nothing left to do, and
          leaving an armed submit button invites a second identical POST. */}
      {!joined && (
        <>
          <label htmlFor={emailId} style={VISUALLY_HIDDEN}>
            Email address
          </label>
          <input
            id={emailId}
            className="wl-input"
            type="email"
            name="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            maxLength={254}
            required
            disabled={submitting}
            aria-invalid={status === "error" || undefined}
          />

          {/* The honeypot. Hidden from sight and from assistive tech, skipped by
              the tab order, and never autofilled — so no human fills it, and a
              submission that does is a bot. The route answers those with the
              ordinary success body and writes nothing. This is the ONLY abuse
              control in v1 (rate limiting was scoped out), so it is not
              decoration. `company` because form-filling bots reach for it. */}
          <div style={VISUALLY_HIDDEN} aria-hidden="true">
            <label htmlFor={`${emailId}-company`}>Company</label>
            <input
              id={`${emailId}-company`}
              type="text"
              name="company"
              defaultValue=""
              tabIndex={-1}
              autoComplete="off"
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
        className={message ? `wl-msg wl-msg-${joined ? "success" : "error"}` : "wl-msg"}
        role="status"
        aria-live="polite"
      >
        {message}
      </p>
    </form>
  );
}
