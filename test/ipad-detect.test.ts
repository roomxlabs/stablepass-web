import { describe, it, expect } from "vitest";
import {
  isIpad,
  isSafari,
  isStandalone,
  shouldOfferInstall,
  readEnv,
  readNativeShell,
  isInAppBrowser,
  NATIVE_SHELL_STORAGE_KEY,
  NATIVE_SHELL_UA_TOKEN,
  type DetectEnv,
} from "@/lib/ipad";

const IPADOS_17_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const LEGACY_IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 12_5_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1";
const DESKTOP_MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_TABLET_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// An SFSafariViewController opened BY the native app forwards a genuine Safari
// user agent — byte-for-byte the same as the one above. That is precisely why
// UA sniffing cannot see it and the native shell must declare itself.
const SFSAFARIVIEWCONTROLLER_UA = IPADOS_17_DESKTOP_UA;
// A native WKWebView that appends its own product token to the UA.
const NATIVE_WEBVIEW_TOKEN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 StablePassApp/1.0";
// A bare WKWebView: no "Safari" product token at all.
const BARE_WKWEBVIEW_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD_CHROME_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1";

function env(overrides: Partial<DetectEnv> = {}): DetectEnv {
  return {
    userAgent: IPADOS_17_DESKTOP_UA,
    platform: "MacIntel",
    maxTouchPoints: 5,
    matchesStandalone: false,
    // iPad Air short side. See DetectEnv.screenMin.
    screenMin: 820,
    nativeShell: false,
    ...overrides,
  };
}

describe("isIpad", () => {
  it("modern iPadOS 17 Safari with the desktop UA disguise -> true (the ticket's regression case)", () => {
    expect(isIpad(env())).toBe(true);
  });

  it("legacy iPad UA (contains 'iPad') -> true", () => {
    expect(isIpad(env({ userAgent: LEGACY_IPAD_UA, platform: "iPad", maxTouchPoints: 5 }))).toBe(true);
  });

  it("real desktop macOS Safari (maxTouchPoints 0) -> false", () => {
    expect(isIpad(env({ maxTouchPoints: 0 }))).toBe(false);
  });

  it("desktop Chrome on macOS -> false", () => {
    expect(isIpad(env({ userAgent: DESKTOP_MAC_CHROME_UA, maxTouchPoints: 0 }))).toBe(false);
  });

  it("iPhone UA -> false (out of scope)", () => {
    expect(isIpad(env({ userAgent: IPHONE_UA, platform: "iPhone", maxTouchPoints: 5 }))).toBe(false);
  });

  it("Android tablet UA -> false", () => {
    expect(isIpad(env({ userAgent: ANDROID_TABLET_UA, platform: "Linux armv8l", maxTouchPoints: 5 }))).toBe(false);
  });

  it("Chrome on iPad (CriOS) -> true (isIpad only cares about the device, not the browser)", () => {
    expect(isIpad(env({ userAgent: IPAD_CHROME_UA, platform: "MacIntel" }))).toBe(true);
  });
});

describe("isSafari", () => {
  it("real Safari UA -> true", () => {
    expect(isSafari(env())).toBe(true);
  });

  it("Chrome on iPad (CriOS) -> false", () => {
    expect(isSafari(env({ userAgent: IPAD_CHROME_UA }))).toBe(false);
  });

  it("desktop Chrome on macOS -> false", () => {
    expect(isSafari(env({ userAgent: DESKTOP_MAC_CHROME_UA }))).toBe(false);
  });
});

describe("isStandalone", () => {
  it("matchesStandalone true -> true", () => {
    expect(isStandalone(env({ matchesStandalone: true }))).toBe(true);
  });

  it("legacy navigator.standalone true -> true", () => {
    expect(isStandalone(env({ standalone: true }))).toBe(true);
  });

  it("neither set -> false", () => {
    expect(isStandalone(env())).toBe(false);
  });
});

describe("shouldOfferInstall", () => {
  it("iPadOS 17 Safari, not standalone -> true", () => {
    expect(shouldOfferInstall(env())).toBe(true);
  });

  it("real desktop macOS Safari -> false", () => {
    expect(shouldOfferInstall(env({ maxTouchPoints: 0 }))).toBe(false);
  });

  it("Chrome on iPad (CriOS) -> false (not Safari)", () => {
    expect(shouldOfferInstall(env({ userAgent: IPAD_CHROME_UA }))).toBe(false);
  });

  it("iPad Safari but matchesStandalone true -> false (already installed)", () => {
    expect(shouldOfferInstall(env({ matchesStandalone: true }))).toBe(false);
  });

  it("iPad Safari but legacy standalone true -> false (already installed)", () => {
    expect(shouldOfferInstall(env({ standalone: true }))).toBe(false);
  });
});

describe("readEnv", () => {
  it("returns null when navigator is missing", () => {
    const fakeWindow = { navigator: undefined } as unknown as Window;
    expect(readEnv(fakeWindow)).toBeNull();
  });

  it("tolerates a window whose matchMedia throws", () => {
    const fakeWindow = {
      navigator: {
        userAgent: IPADOS_17_DESKTOP_UA,
        platform: "MacIntel",
        maxTouchPoints: 5,
      },
      matchMedia: () => {
        throw new Error("matchMedia not implemented");
      },
    } as unknown as Window;

    const result = readEnv(fakeWindow);
    expect(result).not.toBeNull();
    expect(result?.matchesStandalone).toBe(false);
  });

  it("reads a normal window correctly", () => {
    const fakeWindow = {
      navigator: {
        userAgent: IPADOS_17_DESKTOP_UA,
        platform: "MacIntel",
        maxTouchPoints: 5,
        standalone: undefined,
      },
      matchMedia: () => ({ matches: false }),
      screen: { width: 1180, height: 820 },
      location: { href: "https://app.stablepass.co/explore" },
      localStorage: { getItem: () => null, setItem: () => {} },
    } as unknown as Window;

    expect(readEnv(fakeWindow)).toEqual({
      userAgent: IPADOS_17_DESKTOP_UA,
      platform: "MacIntel",
      maxTouchPoints: 5,
      standalone: undefined,
      matchesStandalone: false,
      // The SHORT side of the screen, regardless of orientation.
      screenMin: 820,
      nativeShell: false,
    });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Regressions added after review (ENG-985). Each of these was a real hole.

describe("iPhone in 'Request Desktop Website' mode", () => {
  // iOS Safari's per-site desktop mode sends the MACINTOSH UA and reports
  // platform "MacIntel" with touch points — identical to an iPad on every
  // signal except the hardware. Without the screen check this member is shown
  // a card telling them to add the app to "your iPad".
  const iphoneDesktopMode = {
    userAgent: IPADOS_17_DESKTOP_UA,
    platform: "MacIntel",
    maxTouchPoints: 5,
    // iPhone 15 Pro Max short side.
    screenMin: 430,
  };

  it("is NOT treated as an iPad", () => {
    expect(isIpad(env(iphoneDesktopMode))).toBe(false);
  });

  it("is not offered the install prompt", () => {
    expect(shouldOfferInstall(env(iphoneDesktopMode))).toBe(false);
  });

  it("but a genuine iPad on the same signals still is", () => {
    expect(shouldOfferInstall(env({ ...iphoneDesktopMode, screenMin: 744 }))).toBe(true);
  });

  it("a missing/zero screen fails CLOSED", () => {
    expect(shouldOfferInstall(env({ ...iphoneDesktopMode, screenMin: 0 }))).toBe(false);
  });
});

describe("GUARDRAIL: never inside the native app", () => {
  // The prompt must never surface in the native app. UA sniffing alone cannot
  // enforce this, so the native shell declares itself — these tests pin that.

  it("an SFSafariViewController UA is indistinguishable from Safari (documents WHY the flag exists)", () => {
    // Not a bug — a statement of the threat model. This is the case that made
    // the original "structurally impossible" claim false.
    expect(isSafari(env({ userAgent: SFSAFARIVIEWCONTROLLER_UA }))).toBe(true);
    expect(shouldOfferInstall(env({ userAgent: SFSAFARIVIEWCONTROLLER_UA }))).toBe(true);
  });

  it("...and the nativeShell flag suppresses exactly that case", () => {
    expect(
      shouldOfferInstall(env({ userAgent: SFSAFARIVIEWCONTROLLER_UA, nativeShell: true })),
    ).toBe(false);
  });

  it("a WKWebView appending a StablePass product token is suppressed by UA alone", () => {
    expect(NATIVE_SHELL_UA_TOKEN.test(NATIVE_WEBVIEW_TOKEN_UA)).toBe(true);
  });

  it("a bare WKWebView (no Safari token) is not offered the prompt", () => {
    expect(shouldOfferInstall(env({ userAgent: BARE_WKWEBVIEW_UA }))).toBe(false);
  });

  it("the flag beats every other signal, including a perfect iPad Safari", () => {
    expect(shouldOfferInstall(env({ nativeShell: true }))).toBe(false);
  });
});

describe("readNativeShell", () => {
  function fakeWin(opts: { ua?: string; href?: string; stored?: string | null }) {
    const store = new Map<string, string>();
    if (opts.stored != null) store.set(NATIVE_SHELL_STORAGE_KEY, opts.stored);
    return {
      navigator: { userAgent: opts.ua ?? IPADOS_17_DESKTOP_UA },
      location: { href: opts.href ?? "https://app.stablepass.co/explore" },
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    } as unknown as Window;
  }

  it("false for a plain Safari visit", () => {
    expect(readNativeShell(fakeWin({}))).toBe(false);
  });

  it("true when the UA carries the product token", () => {
    expect(readNativeShell(fakeWin({ ua: NATIVE_WEBVIEW_TOKEN_UA }))).toBe(true);
  });

  it("true on the ?nativeShell=1 query parameter, and persists it", () => {
    const win = fakeWin({ href: "https://app.stablepass.co/explore?nativeShell=1" });
    expect(readNativeShell(win)).toBe(true);
    // Persisted, so the suppression survives in-app navigation that drops it.
    expect(win.localStorage.getItem(NATIVE_SHELL_STORAGE_KEY)).toBe("1");
  });

  it("true from the persisted storage key alone", () => {
    expect(readNativeShell(fakeWin({ stored: "1" }))).toBe(true);
  });
});


describe("iPad in a WebKit in-app browser", () => {
  // These UAs all contain "Safari" and none of the Chrome/Firefox tokens, so
  // before this exclusion existed every one of them was shown "Tap Share in
  // the Safari toolbar" — inside an app that has no Safari toolbar and no Add
  // to Home Screen entry in its share sheet. A dead-end instruction.
  const cases: Array<[string, string]> = [
    [
      "Instagram",
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 Instagram 302.0.0.0.0",
    ],
    [
      "Facebook",
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 [FBAN/FBIOS;FBAV/440.0.0.0]",
    ],
    [
      "LinkedIn",
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 LinkedInApp/9.28.0",
    ],
    [
      "Google app",
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 GSA/300.0.0",
    ],
    [
      "DuckDuckGo",
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Ddg/17.0 Mobile/15E148 Safari/604.1",
    ],
  ];

  for (const [name, ua] of cases) {
    it(`${name} in-app browser is not offered the prompt`, () => {
      expect(isInAppBrowser(env({ userAgent: ua }))).toBe(true);
      expect(isSafari(env({ userAgent: ua }))).toBe(false);
      expect(shouldOfferInstall(env({ userAgent: ua }))).toBe(false);
    });
  }

  it("real Safari on the same device still is", () => {
    expect(shouldOfferInstall(env({ userAgent: LEGACY_IPAD_UA }))).toBe(true);
  });
});
