// iPad "Add to Home Screen" detection — ENG-985.
//
// Pure, dependency-free environment sniffing. No React, no DOM writes: this
// module only classifies a snapshot of navigator/matchMedia state that the
// caller supplies (or that `readEnv` collects), so it can be unit-tested
// without jsdom faking a whole browser.

/** sessionStorage/localStorage key the install-prompt component dismisses under. */
export const INSTALL_DISMISS_KEY = "a2hs-dismissed";

export type DetectEnv = {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** navigator.standalone — legacy iOS-only flag, absent everywhere else. */
  standalone?: boolean;
  /** Result of matchMedia("(display-mode: standalone)").matches. */
  matchesStandalone: boolean;
  /**
   * The SHORTER side of the physical screen, in CSS px (`screen.width`/
   * `screen.height`), independent of orientation and of the window size.
   *
   * This exists to kill a real false positive: an iPHONE with Safari's
   * per-site "Request Desktop Website" turned on ALSO reports the Macintosh
   * UA and `platform === "MacIntel"`, so the touch-plus-platform test alone
   * says "iPad" and the member is shown a card that talks about "your iPad".
   * The UA gives us nothing left to discriminate on at that point — but the
   * hardware does. Every iPad is >= 744 CSS px on its short side; the largest
   * iPhone is 430. Screen size is also immune to the desktop-mode switch,
   * which is exactly why it is the right signal here (the VIEWPORT is not —
   * that changes with split view and would break a legitimately multitasking
   * iPad).
   */
  screenMin: number;
  /**
   * True when this document is being rendered by our own native app's
   * embedded browser rather than by Safari proper.
   *
   * A POSITIVE, non-UA signal, set by the native shell (see
   * `NATIVE_SHELL_FLAGS` below). This is the honest fix for the fact that UA
   * sniffing CANNOT reliably see an `SFSafariViewController` — it forwards a
   * genuine Safari UA, so `isSafari()` says yes and every UA-based defence
   * fails open. Rather than pretend otherwise, the native app tells us.
   */
  nativeShell: boolean;
};

/**
 * How the native app declares itself, in priority order:
 *
 * 1. a `?nativeShell=1` query parameter on the URL it opens, or
 * 2. a `sp-native-shell` key in `localStorage` (set once by the shell, and
 *    what keeps the suppression working across in-app navigation), or
 * 3. a `StablePass`-prefixed product token appended to the UA.
 *
 * Any one is enough. Three mechanisms because the native app is a separate
 * codebase this repo cannot verify, so the web side accepts whichever the
 * shell finds easiest to set — and defaults to SHOWING nothing extra if the
 * shell sets none of them only because the copy is safe either way.
 */
export const NATIVE_SHELL_STORAGE_KEY = "sp-native-shell";
export const NATIVE_SHELL_QUERY_PARAM = "nativeShell";
/** Product token a native WKWebView may append to its user agent. */
export const NATIVE_SHELL_UA_TOKEN = /StablePass(App)?\//;

/**
 * True for an iPad, old or new.
 *
 * iPadOS 13+ Safari ships a Macintosh-flavoured UA by default (Apple's
 * "request desktop site by default" change), so a plain `/iPad/` UA test
 * alone misses every modern iPad — that's the whole bug this ticket exists
 * to fix. A real Mac reports `maxTouchPoints === 0` even with a trackpad, so
 * pairing `platform === "MacIntel"` with `maxTouchPoints > 1` is what
 * separates a disguised iPad from an actual desktop Mac.
 */
/**
 * The short-side screen width, in CSS px, at or above which a touch
 * "Macintosh" is a tablet rather than a phone in desktop mode. See
 * `DetectEnv.screenMin`.
 */
export const IPAD_MIN_SCREEN_PX = 600;

export function isIpad(env: DetectEnv): boolean {
  const ua = env.userAgent;
  // iPhone/iPod are explicitly out of scope for this ticket even though
  // their UAs can also contain "Mac"-like substrings in edge cases.
  if (/iPhone|iPod/.test(ua)) return false;

  // Case (a): old iPadOS, or "Request Mobile Website" turned on — UA still
  // says iPad outright.
  if (/iPad/.test(ua)) return true;

  // Case (b): the iPadOS-13+ desktop-UA disguise described above.
  //
  // `screenMin` is the third term, and it is not optional — WITHOUT it an
  // iPhone in "Request Desktop Website" mode satisfies both other clauses and
  // is told to add the app to "your iPad". 600px sits comfortably between the
  // largest iPhone (430) and the smallest iPad (744), so it needs no revision
  // when Apple nudges either line. A `screenMin` of 0 (a jsdom-ish or
  // screen-less environment) therefore fails CLOSED, which is the right
  // direction for a prompt.
  if (env.platform === "MacIntel" && env.maxTouchPoints > 1 && env.screenMin >= IPAD_MIN_SCREEN_PX) {
    return true;
  }

  return false;
}

/**
 * True only for actual Safari. Add to Home Screen is a Safari-only
 * affordance on iPadOS — an in-app webview, or Chrome/Firefox/Edge/Opera
 * running on iOS/iPadOS (which are all still WebKit under the hood and so
 * still say "Safari" in their UA), must not get the install prompt since
 * they can't act on it the same way.
 */
export function isSafari(env: DetectEnv): boolean {
  const ua = env.userAgent;
  // Chrome (and Chromium) must be excluded before the "Safari" substring
  // check, since desktop/Android Chrome UAs contain BOTH "Chrome" and
  // "Safari".
  const isOtherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|Chrome|Chromium/.test(ua);
  return /Safari/.test(ua) && !isOtherBrowser && !isInAppBrowser(env);
}

/**
 * In-app browsers that are WebKit but are NOT Safari proper.
 *
 * This exists because the exclusion above is not enough on its own. An
 * Instagram / Facebook / LinkedIn in-app browser on an iPad sends a UA that
 * contains `Safari` and contains none of the Chrome/Firefox tokens, so it
 * passed every check and the member was told to "Tap Share in the Safari
 * toolbar" — a toolbar that is not on screen, inside a Share sheet that has no
 * Add to Home Screen entry. A dead-end instruction is worse than no
 * instruction, so these are excluded by their own product tokens.
 */
const IN_APP_BROWSER_TOKENS =
  /FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Twitter|Line\/|MicroMessenger|Snapchat|Pinterest|GSA\/|DuckDuckGo|Ddg/;

/** True for a WebKit in-app browser that cannot perform Add to Home Screen. */
export function isInAppBrowser(env: DetectEnv): boolean {
  return IN_APP_BROWSER_TOKENS.test(env.userAgent);
}

/**
 * True when the app is already running installed (standalone display mode).
 * An already-installed member must never see the install prompt again.
 */
export function isStandalone(env: DetectEnv): boolean {
  return env.matchesStandalone === true || env.standalone === true;
}

/**
 * The single gate the install-prompt component checks before rendering.
 *
 * `!env.nativeShell` is a GUARDRAIL clause, not a nicety: this prompt must
 * never appear inside the native app. UA sniffing cannot enforce that on its
 * own — an `SFSafariViewController` opened by the native app forwards a real
 * Safari user agent, so `isSafari()` returns true for it — which is why the
 * native shell declares itself explicitly instead.
 */
export function shouldOfferInstall(env: DetectEnv): boolean {
  if (env.nativeShell) return false;
  return isIpad(env) && isSafari(env) && !isStandalone(env);
}

/**
 * Whether this document is running inside our native app's browser, by any of
 * the three declaration mechanisms. Reads storage/URL defensively — a throw
 * here must not take out the whole detection.
 */
export function readNativeShell(win: Window): boolean {
  try {
    if (NATIVE_SHELL_UA_TOKEN.test(win.navigator.userAgent)) return true;
  } catch {
    // fall through
  }
  try {
    if (new URL(win.location.href).searchParams.get(NATIVE_SHELL_QUERY_PARAM)) {
      // Persist it, so the suppression survives the next in-app navigation
      // where the parameter is no longer on the URL.
      try {
        win.localStorage.setItem(NATIVE_SHELL_STORAGE_KEY, "1");
      } catch {
        // Storage unavailable — the parameter still suppresses THIS page.
      }
      return true;
    }
  } catch {
    // fall through
  }
  try {
    if (win.localStorage.getItem(NATIVE_SHELL_STORAGE_KEY) !== null) return true;
  } catch {
    // fall through
  }
  return false;
}

/**
 * Reads a `DetectEnv` off a real `Window`, or null when navigator isn't
 * available (SSR / non-browser environments). Kept separate from the pure
 * predicates above so those stay trivially testable with plain object
 * literals.
 */
export function readEnv(win: Window): DetectEnv | null {
  if (typeof win === "undefined" || !win.navigator) return null;

  const nav = win.navigator as Navigator & { standalone?: boolean };

  // matchMedia can throw (or be missing) in older browsers and in jsdom
  // configurations that don't implement it — default to "not standalone"
  // rather than let that throw take out the whole detection.
  let matchesStandalone = false;
  try {
    matchesStandalone = win.matchMedia?.("(display-mode: standalone)")?.matches ?? false;
  } catch {
    matchesStandalone = false;
  }

  // `screen` is absent in some embedded/headless contexts. 0 fails closed —
  // see the `screenMin` note on DetectEnv.
  let screenMin = 0;
  try {
    const w = win.screen?.width ?? 0;
    const h = win.screen?.height ?? 0;
    screenMin = w && h ? Math.min(w, h) : 0;
  } catch {
    screenMin = 0;
  }

  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints ?? 0,
    standalone: nav.standalone,
    matchesStandalone,
    screenMin,
    nativeShell: readNativeShell(win),
  };
}
