"use client";

// The Shares disclaimer (Justin + Mel, 26 Aug 2026 meeting) — a 1:1 port of
// mobile's `src/components/shares-disclaimer.tsx` (ENG-956): a full-width green
// strip reading "Disclaimer" that opens a pop-up card with an X to close. The
// client was explicit that the WORD alone is clear enough — no inline paragraph
// on the screen itself, so the copy must NOT be in the DOM until the card opens.
//
// THE COPY IS LOAD-BEARING AND REUSED VERBATIM from the signed-off marketing
// "Important note" (`app/(marketing)/sections/important-note.tsx`, guardrail #8:
// regulator-facing wording, never paraphrased). `SHARES_DISCLAIMER_COPY` is
// pinned character-for-character by `test/shares-disclaimer.test.tsx` here and
// by `src/components/__tests__/shares-disclaimer.test.tsx` on mobile, so a
// well-meaning edit fails the build on BOTH platforms instead of shipping. If
// Justin supplies shares-specific wording later, replace the whole string —
// never edit it in place.
import { useEffect, useRef, useState } from "react";
import styles from "./shares-disclaimer.module.css";

export const SHARES_DISCLAIMER_COPY =
  "stablepass. is an entertainment and experience subscription. stablepass. does not sell shares in " +
  "racehorses, syndicates, financial products, betting products, prize money rights, or investment returns. " +
  "Subscribers receive content access and racing experiences only.";

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </svg>
);

export function SharesDisclaimer() {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // Escape closes, same as the X and the backdrop — a pop-up card, not a page.
  // Focus moves to the X on open so a keyboard user is not stranded behind the
  // backdrop (React Native's Modal does this for free; the web does not).
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={styles.strip}
        data-testid="shares-disclaimer"
        onClick={() => setOpen(true)}
      >
        Disclaimer
      </button>

      {open && (
        // Backdrop click closes, same as the X. The inner card stops the click
        // so a click INSIDE the card never dismisses it.
        <div
          className={styles.backdrop}
          data-testid="shares-disclaimer-backdrop"
          onClick={() => setOpen(false)}
        >
          <div
            className={styles.card}
            data-testid="shares-disclaimer-card"
            role="dialog"
            aria-modal="true"
            aria-label="Disclaimer"
            onClick={(e) => e.stopPropagation()}
          >
            {/* The brand's serif "S." as a quiet ground mark — decorative only,
                behind the copy, clipped by the card's rounded corners. */}
            <span className={styles.brandMark} aria-hidden="true">
              S.
            </span>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>Disclaimer</h2>
              <button
                type="button"
                ref={closeRef}
                className={styles.closeBtn}
                aria-label="Close disclaimer"
                data-testid="shares-disclaimer-close"
                onClick={() => setOpen(false)}
              >
                <CloseIcon />
              </button>
            </div>
            <p className={styles.cardBody} data-testid="shares-disclaimer-copy">
              {SHARES_DISCLAIMER_COPY}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
