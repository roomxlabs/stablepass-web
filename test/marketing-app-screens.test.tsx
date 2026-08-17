import { readFileSync } from "node:fs";
import path from "node:path";

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The eight app screens in `#mem-apps` (regression cover for the inert arrows).
 *
 * W2 shipped the `[data-ma]` arrows with no handler at all, on the stated
 * contract that W3 would bind them; W3 wired only the trainer strip, so they
 * reached production dead. Nothing tested them, in either ticket, which is
 * exactly why it shipped — so the first test below is the one that matters.
 *
 * `useMarquee` is mocked throughout. jsdom has no layout engine, so every
 * `offsetWidth` is 0, the real hook's clone guard therefore decides "static",
 * and `nudge` returns early before it ever touches a transform. Mocking the hook
 * is what makes the WIRING observable; the hook's own arithmetic is unit-tested
 * against written-down widths in `marketing-marquee.test.ts`.
 */

const { nudgeMock, marqueeState } = vi.hoisted(() => ({
  nudgeMock: vi.fn(),
  marqueeState: { isStatic: false, duplicated: false },
}));

vi.mock("@/app/(marketing)/use-marquee", () => ({
  useMarquee: () => ({
    scrollRef: { current: null },
    trackRef: { current: null },
    isStatic: marqueeState.isStatic,
    duplicated: marqueeState.duplicated,
    nudge: nudgeMock,
  }),
}));

import AppScreensCarousel from "@/app/(marketing)/app-screens-carousel";
import SubscribersGet from "@/app/(marketing)/sections/subscribers-get";

const SCREENS = [
  { src: "/marketing/a.jpg", alt: "screen a", caption: "Stable updates" },
  { src: "/marketing/b.jpg", alt: "screen b", caption: "Photos from the stable" },
  { src: "/marketing/c.jpg", alt: "screen c", caption: "Training & trackwork" },
];

beforeEach(() => {
  nudgeMock.mockClear();
  marqueeState.isStatic = false;
  marqueeState.duplicated = false;
});

describe("app screens carousel — the arrows", () => {
  // THE REGRESSION. These two buttons existed in production with no handler.
  it("moves the row backwards and forwards when the arrows are clicked", () => {
    render(<AppScreensCarousel screens={SCREENS} />);

    fireEvent.click(screen.getByRole("button", { name: "Previous screen" }));
    expect(nudgeMock).toHaveBeenCalledWith(-1);

    fireEvent.click(screen.getByRole("button", { name: "Next screen" }));
    expect(nudgeMock).toHaveBeenCalledWith(1);

    expect(nudgeMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the mockup's [data-ma] hooks on the arrows", () => {
    const { container } = render(<AppScreensCarousel screens={SCREENS} />);

    expect(container.querySelector('[data-ma="-1"]')).not.toBeNull();
    expect(container.querySelector('[data-ma="1"]')).not.toBeNull();
  });
});

describe("app screens carousel — the row", () => {
  it("renders one phone per screen, in order", () => {
    const { container } = render(<AppScreensCarousel screens={SCREENS} />);

    const captions = Array.from(container.querySelectorAll(".ma-row .ma figcaption")).map(
      (node) => node.textContent,
    );
    expect(captions).toEqual(["Stable updates", "Photos from the stable", "Training & trackwork"]);
  });

  it("renders no duplicate set while the strip is static", () => {
    const { container } = render(<AppScreensCarousel screens={SCREENS} />);

    expect(container.querySelectorAll(".ma[data-dup]")).toHaveLength(0);
    expect(container.querySelectorAll(".ma")).toHaveLength(3);
  });

  // The duplicate set is what makes the loop seamless, but it must not reach
  // assistive tech or the caption of every screen is announced twice.
  it("hides the duplicate set from the accessibility tree", () => {
    marqueeState.duplicated = true;
    const { container } = render(<AppScreensCarousel screens={SCREENS} />);

    const dups = container.querySelectorAll(".ma[data-dup]");
    expect(dups).toHaveLength(3);
    expect(container.querySelectorAll(".ma")).toHaveLength(6);

    for (const dup of dups) {
      expect(dup.getAttribute("aria-hidden")).toBe("true");
      // An empty alt keeps the copy out of the tree even where aria-hidden is
      // not honoured; the real card keeps its describing alt.
      expect(dup.querySelector("img")?.getAttribute("alt")).toBe("");
    }
    expect(container.querySelector(".ma:not([data-dup]) img")?.getAttribute("alt")).toBe("screen a");
  });

  /**
   * `data-dup` is load-bearing, not decoration: `measureMarquee` filters on it
   * to size ONE set. Without it the duplicates double `setWidth` and the wrap
   * happens at twice the distance, leaving a gap the width of the strip.
   */
  it("marks duplicates with data-dup so the measurement can exclude them", () => {
    marqueeState.duplicated = true;
    const { container } = render(<AppScreensCarousel screens={SCREENS} />);

    expect(container.querySelectorAll(".ma-row > .ma[data-dup]")).toHaveLength(3);
  });
});

describe("app screens carousel — the static class", () => {
  /**
   * The mockup's shared `marquee()` toggles `is-static` on whichever scroller it
   * is driving, so `.ma-scroll` carries it there too. Asserted as behaviour, not
   * as appearance: unlike `.tr-scroll.is-static`, the mockup ships NO
   * `.ma-scroll.is-static` rule, so the class is currently inert by design.
   *
   * That inertness is a latent defect, not a feature — with scripting off on a
   * desktop pointer the row stays clipped by `.ma-scroll{overflow:hidden}` and
   * five of the eight screens cannot be reached. Adding the rule would put
   * marketing.css out of step with the mockup and break the ordered-diff
   * fidelity guard in `marketing-shell.test.tsx`, so it is deliberately left
   * alone here and raised separately. A phone is unaffected: `@media
   * (hover:none)` turns the row into a native scroll lane with no JS at all.
   */
  it("renders .is-static on the scroller while the strip is static", () => {
    marqueeState.isStatic = true;
    const { container } = render(<AppScreensCarousel screens={SCREENS} />);

    expect(container.querySelector(".ma-scroll")?.className).toContain("is-static");
  });

  it("drops .is-static once the marquee has taken over", () => {
    marqueeState.isStatic = false;
    const { container } = render(<AppScreensCarousel screens={SCREENS} />);

    expect(container.querySelector(".ma-scroll")?.className).not.toContain("is-static");
  });

  // Pins the paragraph above: if someone adds the rule, they have to deal with
  // the fidelity guard at the same time rather than discovering it in CI.
  it("has no .ma-scroll.is-static rule, matching the mockup", () => {
    const css = readFileSync(path.join(process.cwd(), "app", "(marketing)", "marketing.css"), "utf8");

    expect(css).not.toContain(".ma-scroll.is-static");
    // Positive control: the trainer strip's equivalent IS in the mockup.
    expect(css).toContain(".tr-scroll.is-static");
  });
});

describe("subscribers-get section", () => {
  it("hands all eight real app screens to the carousel", () => {
    const { container } = render(<SubscribersGet />);

    expect(container.querySelectorAll(".ma-row .ma")).toHaveLength(8);
    expect(container.querySelector('[data-ma="1"]')).not.toBeNull();
  });

  // Guardrail #8: the v2.6 asset showed a market price where v2.7 shows weight.
  it("keeps the v2.7 post-race asset, not the v2.6 one", () => {
    const { container } = render(<SubscribersGet />);

    const sources = Array.from(container.querySelectorAll(".ma-row .ma img")).map((img) =>
      img.getAttribute("src"),
    );
    expect(sources).toContain("/marketing/3334430f.jpg");
  });
});
