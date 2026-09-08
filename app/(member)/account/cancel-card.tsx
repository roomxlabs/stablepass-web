"use client";

// The Cancel control on the Account screen's Subscription card (ENG-1002).
//
// ─────────────────────────────────────────────────────────────────────────────
// NO MOCKUP FOR THIS CONTROL. `09-account.html` — the confirmed reference for
// this screen — has no cancel affordance and no confirm dialog, because when it
// was drawn the pass was a non-renewing trial-then-buy flow with nothing to
// cancel (ENG-567 deleted the route outright). ENG-999 brought cancellation
// back, so this is a genuine design gap and it is flagged on the PR.
//
// A gap is not a licence to invent, so every value below comes from the system
// already on this screen — the same discipline `expiry-banner.tsx` used when it
// reused `.trial-banner-web` rather than adding CSS:
//
//   * the idle control is a `.settings-row.notif-row` (title + `.notif-sub`
//     explanation on the left, control on the right) — the exact row shape the
//     Notifications card on this same screen already uses;
//   * the button is `.btn.btn-light` tinted with `var(--red)`, which is
//     VERBATIM the destructive-control treatment `account-forms.tsx` uses for
//     Sign out — the only destructive control the design system has;
//   * the confirm step reuses `.plan-card-inner` padding, `.input-label` +
//     `.input` (the Profile form's fields), `.form-error` and `.btn`;
//   * `--line`, `--muted`, `--red`, `--ink` only. No new colour, no new font
//     size, no modal — this app has no dialog component family and adding one
//     for a single control would be inventing a design, not composing one.
//
// The confirm is therefore an IN-CARD expansion rather than an overlay. That is
// the conservative reading of the gap, and it has a real advantage over a modal
// here: the sentence naming the date the member keeps access to stays on screen
// next to the card that just stated it.
//
// Inline styles are LAYOUT ONLY, never treatment — same rule as the banner.
//
// ─────────────────────────────────────────────────────────────────────────────
// GUARDRAILS
//   * The comment is UNTRUSTED MEMBER TEXT. It is written to the request body
//     and never read back: this component does not render it after submitting,
//     nothing else in this app renders `cancel_reason`, and it never touches
//     `dangerouslySetInnerHTML`. It is capped at 500 here AND validated by the
//     route AND CHECKed by the DB — three layers, and this one is only the
//     courtesy.
//   * The write goes to `/api/subscription/cancel`, which calls the
//     `SECURITY DEFINER` RPC. This island holds no user id, no token and no
//     Supabase URL; it posts to a same-origin path and the httpOnly cookie does
//     the rest.
//   * This is CHROME. It renders no gated content and cannot suppress the 402
//     path — it only ever asks the server to change a status.
import { useState } from "react";
import { useRouter } from "next/navigation";

/** Mirrors the route's own limit, which mirrors the DB CHECK. */
export const MAX_REASON = 500;

export function CancelCard({ endDate }: { endDate: string | null }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function cancel() {
    setBusy(true);
    setError(null);
    const trimmed = reason.trim();

    // `fetch` REJECTS on offline / DNS failure / connection reset — it does not
    // resolve with an !ok response. Without this catch that rejection escapes as
    // an unhandled promise, `setBusy(false)` never runs, and the member is left
    // staring at a disabled "Cancelling…" with the Keep button disabled too and
    // no way out but a reload. The !ok paths below all recover correctly, which
    // is exactly what made this easy to miss.
    let res: Response;
    try {
      res = await fetch("/api/subscription/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Absent, not empty-string: a whitespace-only comment is no comment, and
        // the route stores null for it rather than a blank row of text Mel then
        // has to read past.
        body: JSON.stringify(trimmed ? { reason: trimmed } : {}),
      });
    } catch {
      setError("Couldn't reach the server. Please check your connection and try again.");
      setBusy(false);
      return;
    }

    if (res.ok) {
      // The server component owns every word on this card, so the way to show
      // the cancelled state is to re-render it from the row that just changed —
      // not to keep a second copy of the status in here and let the two drift.
      router.refresh();
      return;
    }

    const body = await res.json().catch(() => null);
    if (body?.error?.code === "no_active_subscription") {
      // Already cancelled (another tab, or a double submit). Nothing is wrong
      // with the account — this screen is just stale, so refresh it rather than
      // showing an error for a thing that already happened.
      router.refresh();
      return;
    }
    setError(body?.error?.message ?? "Couldn't cancel your subscription. Please try again.");
    setBusy(false);
  }

  if (!confirming) {
    return (
      <div className="settings-row notif-row" style={{ borderTop: "1px solid var(--line)" }}>
        <div>
          <div className="notif-title">Cancel your subscription</div>
          <div className="notif-sub">
            {/*
              `endDate` is non-null in practice: the page only mounts this
              island once `current_period_end` has landed, precisely so neither
              sentence here can promise continuity the RPC would revoke (see the
              `canCancel` note in page.tsx). The fallback is defensive — an
              unparseable timestamp — and deliberately promises nothing.
            */}
            {endDate
              ? `You'll keep full access until ${endDate}.`
              : "Your access continues to the end of this period."}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-light"
          style={{ color: "var(--red)", borderColor: "var(--line)" }}
          data-testid="cancel-open"
          onClick={() => setConfirming(true)}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div
      style={{ borderTop: "1px solid var(--line)", padding: "22px 26px 26px" }}
      data-testid="cancel-confirm"
    >
      <div className="notif-title" style={{ marginBottom: 6 }}>
        Cancel your subscription?
      </div>
      <p style={{ fontSize: 13.5, color: "var(--muted)", margin: "0 0 18px", lineHeight: 1.55 }}>
        {endDate
          ? `Your access continues until ${endDate}. After that, your subscription ends and you won't be charged again.`
          : "Your access continues to the end of this period. After that, your subscription ends and you won't be charged again."}
      </p>

      <div className="input-group">
        <label className="input-label" htmlFor="cancel-reason">
          Anything you&rsquo;d like to tell us? (optional)
        </label>
        <textarea
          id="cancel-reason"
          className="input"
          // Layout only — `.input` was authored for single-line fields and
          // carries every colour, border and font value used here.
          style={{ minHeight: 96, resize: "vertical", lineHeight: 1.5 }}
          maxLength={MAX_REASON}
          value={reason}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
        <div
          style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 6, textAlign: "right" }}
          data-testid="cancel-reason-count"
        >
          {reason.length}/{MAX_REASON}
        </div>
      </div>

      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {/* The keep-it choice leads, and it is the PRIMARY button. The
            destructive one is the quiet, light-tinted one — the same weighting
            Sign out gets, and the reason the confirm exists at all. */}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setReason("");
            setError(null);
          }}
        >
          Keep my access
        </button>
        <button
          type="button"
          className="btn btn-light"
          style={{ color: "var(--red)", borderColor: "var(--line)" }}
          data-testid="cancel-confirm-submit"
          disabled={busy}
          onClick={cancel}
        >
          {busy ? "Cancelling…" : "Yes, cancel"}
        </button>
      </div>
    </div>
  );
}
