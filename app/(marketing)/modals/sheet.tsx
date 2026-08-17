"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The shared dialog shell behind `#tr-modal` and `#sheet-faq` (ENG-589 / W3).
 *
 * The mockup drives both overlays from one pair of `open()` / `close()`
 * helpers, so they share a shell here too: scrim click, `[data-close]`, Esc,
 * body scroll lock, and the single-open invariant.
 *
 * Two deliberate departures from the source, both required by the ticket's
 * acceptance criteria rather than invented here:
 *
 *   - **Focus returns to the trigger on close.** The source focuses the close
 *     button on open and then drops focus at the body on close, which sends a
 *     keyboard visitor back to the top of the page.
 *   - **Focus is trapped while open.** `aria-modal="true"` claims the rest of
 *     the page is inert; without a trap that claim is false and Tab walks
 *     straight out behind the scrim.
 */

/**
 * The single-open invariant, held at module scope rather than in React state.
 *
 * It has to be module-wide because the two dialogs have different owners — the
 * trainer modal belongs to `<TrainerCarousel/>` and the FAQ sheet to the footer
 * — so no common ancestor holds "which one is open". In practice the scrim
 * makes a second trigger unclickable, but the invariant is asserted by a test
 * and should hold because it is enforced, not because the CSS happens to.
 */
let releaseOpenSheet: (() => void) | null = null;

/**
 * The scroll lock, held at module scope for the same reason and with a subtler
 * one on top.
 *
 * A per-dialog snapshot is WRONG across a handover: the incoming dialog would
 * read `overflow` while the outgoing one still has it `hidden`, record "hidden"
 * as the page's own value, and restore that on close — leaving the page
 * permanently unscrollable with no dialog open. So the lock is acquired once,
 * snapshots the page's real value, and is released only by whichever dialog is
 * still holding it.
 */
let releaseBodyScroll: (() => void) | null = null;

function lockBodyScroll(): void {
  // Already locked by the dialog we are taking over from — keep its snapshot.
  if (releaseBodyScroll) return;

  const previous = document.body.style.overflow;
  document.body.style.overflow = "hidden";
  releaseBodyScroll = () => {
    document.body.style.overflow = previous;
    releaseBodyScroll = null;
  };
}

/**
 * The ported CSS shows a dialog with `.sheet[open]` / `.tr-modal[open]`, so the
 * literal attribute has to land on a plain `<div>`. `open` is not on the
 * `<div>` prop type, so it is spread in rather than written as a prop.
 *
 * It must be `true`, NOT `""`. React knows `open` as a BOOLEAN attribute (it is
 * one on `<details>`/`<dialog>`) and applies that rule whatever the tag, so an
 * empty string reads as false and React omits the attribute entirely — the
 * dialog then never matches `[open]` and never becomes visible.
 */
function openAttribute(open: boolean): Record<string, boolean> {
  return open ? { open: true } : {};
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

function trapFocus(event: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  /**
   * `!root.contains(active)` has to be on BOTH branches, not just the backward
   * one. Most of a dialog is non-focusable content — the trainer modal's
   * photograph is about half its area — and clicking it blurs focus to
   * `<body>`, which is outside the dialog. From there a plain Tab would walk
   * into the nav behind the scrim while `aria-modal="true"` claims the rest of
   * the page is inert.
   */
  const outside = !root.contains(active);

  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

export type SheetProps = {
  /** `tr-modal` / `sheet-faq` — the mockup's own ids. */
  id: string;
  /** The overlay class the ported CSS keys on: `sheet` or `tr-modal`. */
  className: string;
  /** `sheet-card`, `sheet-card sheet-wide`, or `trm-card`. */
  cardClassName: string;
  /** Id of the heading inside `children` that names this dialog. */
  labelledBy: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
};

export default function Sheet({
  id,
  className,
  cardClassName,
  labelledBy,
  open,
  onClose,
  children,
}: SheetProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  // Read through a ref so a caller passing an inline arrow does not tear the
  // open/close effect down and rebuild it on every render — which would refocus
  // the close button and re-lock scrolling on every keystroke elsewhere.
  // Synced in its own effect, declared FIRST so it lands before the effect
  // below reads it; assigning during render is what `react-hooks/refs` forbids.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    // Close whatever was open before taking the slot.
    releaseOpenSheet?.();
    const release = () => onCloseRef.current();
    releaseOpenSheet = release;

    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    lockBodyScroll();
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key === "Tab") trapFocus(event, rootRef.current);
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);

      /**
       * If another dialog already claimed the slot then this teardown is the
       * tail of a handover, not a close. Restoring the scroll lock or yanking
       * focus back here would undo what the incoming dialog just set up.
       */
      if (releaseOpenSheet !== release) return;

      releaseOpenSheet = null;
      releaseBodyScroll?.();
      triggerRef.current?.focus();
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      id={id}
      className={className}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      // The scrim is the overlay itself, so a click that did not come from the
      // card inside it is a click on the backdrop.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      {...openAttribute(open)}
    >
      {/**
       * The card exists only while the dialog is open. `.sheet`/`.tr-modal` are
       * `display:none` when closed, so this is not what hides it — but a closed
       * dialog that still renders its close glyph puts a stray "×" into the
       * section's text content, which the frozen copy fixture in
       * `test/marketing-home.test.tsx` reads as copy drift. It is right anyway:
       * nothing inside a closed dialog should be in the document at all.
       */}
      {open && (
        <div className={cardClassName}>
          <button
            ref={closeButtonRef}
            className="trm-x"
            type="button"
            data-close=""
            aria-label="Close"
            onClick={onClose}
          >
            &times;
          </button>
          {children}
        </div>
      )}
    </div>
  );
}
