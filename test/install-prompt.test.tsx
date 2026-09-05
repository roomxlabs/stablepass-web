// ENG-985 — the install prompt's BEHAVIOUR: who sees it, and that a dismissal
// sticks. The detection rules themselves are unit-tested against plain object
// literals in ./ipad-detect.test.ts; this file exercises the component wiring
// on top of them, which is where the two interesting bugs would live — a prompt
// that renders for everyone because the env was never read, and a dismissal
// that does not survive a remount.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InstallPrompt } from "@/app/(member)/install-prompt";

// The component reads the current route to stay off /checkout.
let mockPathname = "/explore";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));
import { INSTALL_DISMISS_KEY } from "@/lib/ipad";

/** The modern iPadOS 17 Safari UA — a MACINTOSH string. See lib/ipad.ts. */
const IPAD_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Point jsdom's navigator/matchMedia at a chosen browser.
 *
 * `navigator.userAgent`/`platform`/`maxTouchPoints` are read-only getters in
 * jsdom, so they have to be redefined rather than assigned.
 */
function asBrowser(opts: {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  standalone?: boolean;
}) {
  for (const [key, value] of Object.entries({
    userAgent: opts.userAgent,
    platform: opts.platform,
    maxTouchPoints: opts.maxTouchPoints,
  })) {
    Object.defineProperty(window.navigator, key, { value, configurable: true });
  }
  // A genuine iPad short side — the detector now requires a tablet-sized
  // screen so an iPhone in desktop mode cannot masquerade as an iPad.
  Object.defineProperty(window, "screen", {
    configurable: true,
    value: { width: 1180, height: 820 },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("display-mode: standalone")
        ? opts.standalone === true
        : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  mockPathname = "/explore";
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("InstallPrompt", () => {
  it("shows the Share → Add to Home Screen steps on an iPad in Safari", () => {
    asBrowser({ userAgent: IPAD_UA, platform: "MacIntel", maxTouchPoints: 5 });
    render(<InstallPrompt />);

    const prompt = screen.getByTestId("install-prompt");
    expect(prompt).toBeTruthy();
    // The instruction has to name both halves of the real gesture, or it is
    // not actionable — that is the acceptance criterion, not the heading.
    expect(prompt.textContent).toContain("Share");
    expect(prompt.textContent).toContain("Add to Home Screen");
  });

  it("GUARDRAIL: the copy is about installing, never about buying", () => {
    // Reader-app positioning (decided 2 Sep). This prompt must never read as
    // steering an iOS user to an external purchase. A copy edit that
    // reintroduces store/purchase language should fail the build, not ship.
    //
    // The list is STEMS, not whole words, because the first version of this
    // test listed only "buy"/"subscribe"/"price"/"$" and every one of
    // "pricing", "subscription", "upgrade", "membership", "unlock" and "full
    // version" sailed straight through it. A guardrail test that is trivially
    // reworded around is worse than none, because it looks like cover.
    asBrowser({ userAgent: IPAD_UA, platform: "MacIntel", maxTouchPoints: 5 });
    render(<InstallPrompt />);

    const prompt = screen.getByTestId("install-prompt");
    const text = (prompt.textContent ?? "").toLowerCase();
    for (const banned of [
      "app store",
      "stor", // store, app store
      "purchas", // purchase, purchasing
      "subscri", // subscribe, subscription
      "pric", // price, pricing
      "upgrad", // upgrade, upgrading
      "download",
      "unlock",
      "membership",
      "full app",
      "full version",
      "checkout",
      "billing",
      "payment",
      "trial",
      "free",
      "$",
      "aud",
      "£",
      "€",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("GUARDRAIL: the prompt contains no links at all", () => {
    // The banned-word list can only see TEXT. An <a href="https://apps.apple
    // .com/…">Learn more</a> would pass every assertion above while being
    // precisely the thing the guardrail exists to prevent. So assert the
    // structure too: this card is an instruction, and an instruction needs no
    // outbound link.
    asBrowser({ userAgent: IPAD_UA, platform: "MacIntel", maxTouchPoints: 5 });
    render(<InstallPrompt />);

    const prompt = screen.getByTestId("install-prompt");
    expect(prompt.querySelectorAll("a")).toHaveLength(0);
    expect(prompt.querySelectorAll("[href]")).toHaveLength(0);
  });

  it("does not render on a real desktop Mac (maxTouchPoints 0)", () => {
    asBrowser({ userAgent: IPAD_UA, platform: "MacIntel", maxTouchPoints: 0 });
    render(<InstallPrompt />);
    expect(screen.queryByTestId("install-prompt")).toBeNull();
  });

  it("does not render in desktop Chrome", () => {
    asBrowser({ userAgent: DESKTOP_CHROME_UA, platform: "MacIntel", maxTouchPoints: 0 });
    render(<InstallPrompt />);
    expect(screen.queryByTestId("install-prompt")).toBeNull();
  });

  it("does not render when already installed (standalone display mode)", () => {
    asBrowser({
      userAgent: IPAD_UA,
      platform: "MacIntel",
      maxTouchPoints: 5,
      standalone: true,
    });
    render(<InstallPrompt />);
    expect(screen.queryByTestId("install-prompt")).toBeNull();
  });

  it("GUARDRAIL: does not render over the checkout screen", () => {
    // The embedded Stripe payment screen is the one place an install card and
    // a real purchase would share a viewport — the exact adjacency the
    // reader-app decision was about (and at iPad portrait it could overlap the
    // pay button). Pinned so nobody removes the exclusion casually.
    mockPathname = "/checkout";
    asBrowser({ userAgent: IPAD_UA, platform: "MacIntel", maxTouchPoints: 5 });
    render(<InstallPrompt />);
    expect(screen.queryByTestId("install-prompt")).toBeNull();
  });

  it("dismisses permanently — the prompt does not come back on a remount", async () => {
    asBrowser({ userAgent: IPAD_UA, platform: "MacIntel", maxTouchPoints: 5 });
    const user = userEvent.setup();

    const first = render(<InstallPrompt />);
    await user.click(screen.getByTestId("install-prompt-dismiss"));
    expect(screen.queryByTestId("install-prompt")).toBeNull();
    // localStorage, not sessionStorage: "permanently" has to outlive the tab.
    expect(window.localStorage.getItem(INSTALL_DISMISS_KEY)).not.toBeNull();

    // A fresh mount is the closest this suite gets to "they came back
    // tomorrow" — same storage, new component tree.
    first.unmount();
    render(<InstallPrompt />);
    expect(screen.queryByTestId("install-prompt")).toBeNull();
  });

  it("the close affordance dismisses as well as the Got it button", async () => {
    asBrowser({ userAgent: IPAD_UA, platform: "MacIntel", maxTouchPoints: 5 });
    const user = userEvent.setup();

    render(<InstallPrompt />);
    await user.click(screen.getByTestId("install-prompt-close"));
    expect(screen.queryByTestId("install-prompt")).toBeNull();
    expect(window.localStorage.getItem(INSTALL_DISMISS_KEY)).not.toBeNull();
  });
});
