"use client";

// "Add to Home Screen" prompt — the iPad install path (ENG-985).
//
// WHY THIS EXISTS. There is no iPad build in the submission plan, and there is
// not going to be one: an iPad user gets StablePass the same way the admin does
// — open it in Safari and add it to the Home Screen. Several trainers and a real
// slice of the audience are on iPads, so the install path cannot be tribal
// knowledge; the app has to say it. This is the "flag" from the 2 Sep session:
// detect that we are being opened on an iPad and show the steps.
//
// ─────────────────────────────────────────────────────────────────────────────
// GUARDRAIL — READER-APP POSITIONING (decided 2 Sep, ticket guardrail 1).
// The copy below is an ACCESS INSTRUCTION, never a purchase steer. It explains
// how to install a web app on a tablet that has no native build. It must never
// mention the App Store, buying, subscribing, prices, or "get the full version".
// Anyone editing the strings here is editing a compliance-sensitive surface —
// keep it about INSTALLING. `test/install-prompt.test.tsx` fails the build if
// store/purchase language or any anchor element reappears.
//
// NEVER INSIDE THE NATIVE APP — and this is NOT structurally guaranteed, so do
// not assume it. An earlier version of this comment claimed the native app
// "cannot" reach this component; review showed that is false. An
// SFSafariViewController opened BY the native app forwards a genuine Safari
// user agent, byte-identical to real Safari, so every UA-based defence fails
// open for it. The actual defence is a POSITIVE declaration from the native
// shell — `?nativeShell=1`, a `sp-native-shell` storage key, or a StablePass
// UA product token — which `shouldOfferInstall` honours above all other
// signals. See `lib/ipad.ts`. If the native app ever opens a member URL in an
// embedded browser, it must set one of those three.
//
// GUARDRAIL — this is CHROME, NOT CONTENT (.rx/guardrails.md #3). It renders a
// static instruction and a dismiss control. It fetches nothing, renders no gated
// content, and cannot influence the 402 path either way.
//
// GUARDRAIL — no cookie or domain config is touched (ticket guardrail 2). The
// dismissal is `localStorage` on the app origin. Host-only cookies are why the
// domain split exists and nothing here goes near them.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO MOCKUP. The design source (`.rx/mockups.md` → `06-stage1-design/mockups/
// web/`) has eight screens and none of them is an install prompt — verified, not
// assumed. So, exactly as `./expiry-banner.tsx` did for the same reason, every
// value below is composed from the EXISTING token set rather than invented:
// `--white` ground, `--shadow-lg`, `--radius-lg`, `--line` hairline, and the
// `.trial-label` eyebrow / `.trial-detail` body pairing already used by
// `.trial-banner-web`. The buttons are the stock `.btn` family. No new colour,
// no new font size, no new radius, and deliberately NO addition to globals.css —
// a one-surface component does not get to grow the design system. The missing
// install-prompt screen is flagged on the PR as a design gap.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE DETECTION LIVES IN `lib/ipad.ts` AND NOT HERE.
// iPadOS 13+ Safari reports a MACINTOSH desktop user agent by default, so the
// naive `/iPad/` sniff misses essentially every modern iPad. The real test is
// touch-plus-platform (`MacIntel` + `maxTouchPoints > 1`), which is subtle
// enough to deserve its own unit-tested module rather than being buried in a
// component's render. See `lib/ipad.ts` and `test/ipad-detect.test.ts`.
import { useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { INSTALL_DISMISS_KEY, readEnv, shouldOfferInstall } from "@/lib/ipad";

/**
 * Routes this prompt stays off, whatever the device says.
 *
 * `/checkout` is a GUARDRAIL exclusion, not a cosmetic one. It is the embedded
 * Stripe payment screen, and it is the one place in the app where an install
 * card and a real purchase would share a viewport — exactly the adjacency the
 * 2 Sep reader-app decision was about. A card about installing, floating over
 * a payment form, is the single most misreadable placement available to us, and
 * at iPad portrait it can also sit on top of the pay button. So: not there.
 */
const SUPPRESSED_PATHS = ["/checkout"];

function isSuppressedPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return SUPPRESSED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// ── Reading the dismissal without a setState-in-effect ──────────────────────
// Same shape as `./expiry-banner.tsx`, and for the same two reasons: the
// storage this reads does not exist during the server render, and the naive
// "read it in a useEffect and setState" is a cascading render the lint rule
// (react-hooks/set-state-in-effect) rightly rejects. `useSyncExternalStore`
// renders the SERVER snapshot through hydration and only then swaps in the
// client one — so there is no flash of a prompt this member already dismissed,
// and no hydration mismatch.
//
// The DIFFERENCE from the expiry banner is the storage and the key shape.
// That banner uses `sessionStorage` keyed by the date being warned about, so it
// re-arms next period — correct there, wrong here. An install instruction has
// no period and nothing to re-arm for: dismissing it means "I know how, stop
// telling me". So this is `localStorage` (survives the session) holding a flat
// marker. Acceptance criterion: "dismisses permanently".
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Sentinel for "the client has not read storage yet" — keeps the prompt down. */
const NOT_HYDRATED = "__not_hydrated__";

/** What a dismissal stores. Any non-null value counts as dismissed. */
const DISMISSED = "1";

function getServerSnapshot(): string {
  return NOT_HYDRATED;
}

function getSnapshot(): string | null {
  try {
    return window.localStorage.getItem(INSTALL_DISMISS_KEY);
  } catch {
    // Storage can throw (private mode, blocked site data). Showing the prompt
    // is the safe failure — it is an instruction, not a wall. The in-memory
    // `clicked` state below still hides it for this session if they dismiss.
    return null;
  }
}

/**
 * Whether this visitor should be offered the install instruction.
 *
 * Read through the SAME external-store channel as the dismissal so both land in
 * one client snapshot after hydration. It is a function of the browser only, so
 * the server snapshot is a flat `false` — the server has no navigator to ask,
 * and guessing would mean rendering the prompt for everyone and hiding it a beat
 * later.
 */
function getOfferSnapshot(): boolean {
  const env = readEnv(window);
  return env !== null && shouldOfferInstall(env);
}

function getOfferServerSnapshot(): boolean {
  return false;
}

/** The Safari Share glyph — the control the copy tells them to reach for. */
function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ verticalAlign: "-3px" }}
    >
      {/* Box open at the top, arrow rising out of it — iOS's share mark. */}
      <path d="M12 15V3" />
      <path d="M8 7l4-4 4 4" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

export function InstallPrompt() {
  const storedDismissal = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const offered = useSyncExternalStore(subscribe, getOfferSnapshot, getOfferServerSnapshot);
  // The click's own record, so the card still goes away when storage is
  // unavailable and the write below silently failed. setState in an event
  // handler is exactly where it belongs.
  const [clicked, setClicked] = useState(false);
  const pathname = usePathname();

  if (
    storedDismissal === NOT_HYDRATED ||
    storedDismissal !== null ||
    clicked ||
    !offered ||
    isSuppressedPath(pathname)
  ) {
    return null;
  }

  function dismiss() {
    setClicked(true);
    try {
      window.localStorage.setItem(INSTALL_DISMISS_KEY, DISMISSED);
    } catch {
      // Non-fatal — `clicked` above already hid it for this session.
    }
    // Storage fires no event in the tab that wrote it, so nudge the store.
    listeners.forEach((l) => l());
  }

  return (
    <div
      // Anchored to the bottom of the viewport rather than pushed into the
      // document flow: this is an aside about the browser, not a message about
      // the member's account, and the feed underneath must stay readable while
      // they go looking for the Share control in Safari's toolbar. `--shadow-lg`
      // is the token that already means "floats above the page".
      role="dialog"
      aria-modal="false"
      aria-labelledby="install-prompt-title"
      data-testid="install-prompt"
      style={{
        position: "fixed",
        left: "50%",
        transform: "translateX(-50%)",
        // Clear of the iPad home indicator when running in Safari.
        bottom: "max(20px, env(safe-area-inset-bottom))",
        // BELOW the mobile nav drawer (z-index 40) and its scrim (30) in
        // globals.css. Those are active under `max-width: 899px`, which
        // INCLUDES iPad portrait at 834px — the very width this ticket exists
        // for. At z-index 50 the card floated on top of an open drawer and its
        // sign-out footer. 25 keeps it above page content and under both.
        zIndex: 25,
        width: "min(560px, calc(100vw - 40px))",
        display: "flex",
        alignItems: "flex-start",
        gap: 16,
        padding: "18px 20px",
        background: "var(--white)",
        border: "1px solid var(--line)",
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      {/* The app's own mark, so the card reads as StablePass speaking rather
          than as a browser notification, and previews the Home Screen icon it
          is talking about.

          Rendered through the `.brandmark` MASK rather than an `<img>`, which
          is how the member space already draws this asset (see `.brandmark` in
          globals.css and the sidebar's use of it): the mark is a silhouette
          tinted by `background`, so it takes the brand colour from a token
          instead of baking it into a bitmap. It also keeps the tile decorative
          for assistive tech without an empty-alt `<img>`, and avoids the
          `@next/next/no-img-element` warning that raw tag would add. */}
      <div
        aria-hidden="true"
        style={{
          width: 44,
          height: 44,
          flex: "none",
          borderRadius: "var(--radius-sm)",
          background: "var(--brand-green-soft)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span
          className="brandmark"
          style={{
            display: "block",
            width: 22,
            background: "var(--brand-green)",
          }}
        />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/*
          The eyebrow/body pairing is the one from `.trial-banner-web`, but the
          values are restated here because those two rules are SCOPED to that
          class (`.trial-banner-web .trial-label`) and this card is deliberately
          not a `.trial-banner-web` — that class carries a green band and a left
          rule, which is the wrong treatment for a floating card. Applying the
          bare class name silently produced unstyled browser defaults (caught in
          the first screenshot pass, not by any assertion).

          These are the design system's own numbers, copied, not invented — and
          copied INTO the component rather than promoted into globals.css,
          because one surface does not get to widen the shared sheet.
        */}
        <div
          id="install-prompt-title"
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--brand-green)",
            marginBottom: 4,
          }}
        >
          Add to Home Screen
        </div>
        <div style={{ fontSize: 14, color: "var(--ink)", lineHeight: 1.5 }}>
          {/* GUARDRAIL COPY — installing, never buying. See the header note. */}
          Keep StablePass one tap away on your iPad. Tap{" "}
          <ShareIcon />{" "}
          <strong style={{ fontWeight: 600 }}>Share</strong> in the Safari
          toolbar, then choose{" "}
          <strong style={{ fontWeight: 600 }}>Add to Home Screen</strong>.
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={dismiss}
            data-testid="install-prompt-dismiss"
            style={{ fontSize: 14, padding: "10px 20px" }}
          >
            Got it
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        data-testid="install-prompt-close"
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 4,
          lineHeight: 1,
          fontSize: 18,
          color: "var(--muted)",
          flex: "none",
        }}
      >
        &times;
      </button>
    </div>
  );
}
