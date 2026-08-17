import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import MarketingFooter from "@/app/(marketing)/footer";
import { CONTACT_EMAIL, contactMailtoHref } from "@/app/(marketing)/modals/contact-mailto";
import TrainerCarousel from "@/app/(marketing)/trainer-carousel";
import { TRAINERS } from "@/app/(marketing)/sections/trainers.data";

/**
 * The interactive layer: the duplicate set's accessibility, the dialogs' focus
 * contract, and the two footer columns that stopped being buttons (ENG-589/W3).
 */

/**
 * jsdom implements neither `matchMedia` nor layout, so the marquee can only be
 * driven from a test if both are supplied. These helpers make the component
 * believe it is on a 1100px hover-capable desktop showing 222px cards, which is
 * the case where it clones.
 */
const CARD_WIDTH = 222;
const STRIP_WIDTH = 1100;

function stubViewport({ hoverNone = false, reducedMotion = false } = {}) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("hover: none") ? hoverNone : query.includes("reduce") ? reducedMotion : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("tr-card") ? CARD_WIDTH : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("tr-scroll") ? STRIP_WIDTH : 0;
    },
  });
}

beforeEach(() => {
  stubViewport();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const prop of ["offsetWidth", "clientWidth"] as const) {
    Reflect.deleteProperty(HTMLElement.prototype, prop);
  }
  document.body.style.overflow = "";
});

describe("trainer marquee — the duplicate set", () => {
  it("clones the set once it has measured, and drops .is-static when it does", () => {
    const { container } = render(<TrainerCarousel trainers={TRAINERS} />);

    expect(container.querySelectorAll('.tr-card[data-dup="1"]')).toHaveLength(TRAINERS.length);
    expect(container.querySelector(".tr-scroll")?.className).not.toContain("is-static");
  });

  /**
   * The whole reason the clones are marked. Without `aria-hidden` and without
   * dropping `tabIndex`, nineteen trainers are announced twice and sit in the
   * tab order twice — the strip becomes 38 stops for a keyboard visitor.
   */
  it("hides every clone from assistive tech and from the tab order", () => {
    const { container } = render(<TrainerCarousel trainers={TRAINERS} />);
    const clones = [...container.querySelectorAll('.tr-card[data-dup="1"]')];

    expect(clones.length).toBeGreaterThan(0);
    for (const clone of clones) {
      expect(clone).toHaveAttribute("aria-hidden", "true");
      expect(clone).not.toHaveAttribute("tabindex");
      expect(clone).not.toHaveAttribute("role");
    }

    // The real cards keep both, so the strip is still fully reachable.
    const originals = [...container.querySelectorAll(".tr-card:not([data-dup])")];
    expect(originals).toHaveLength(TRAINERS.length);
    for (const card of originals) {
      expect(card).toHaveAttribute("tabindex", "0");
      expect(card).toHaveAttribute("role", "button");
    }
  });

  it("stays static, with no clones, below the minimum card count", () => {
    // Four trainers: the width test would pass, the count test must not.
    const { container } = render(<TrainerCarousel trainers={TRAINERS.slice(0, 4)} />);

    expect(container.querySelectorAll("[data-dup]")).toHaveLength(0);
    expect(container.querySelector(".tr-scroll")?.className).toContain("is-static");
  });

  it("runs no rAF loop on touch, and leaves the strip natively scrollable", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    stubViewport({ hoverNone: true });

    const { container } = render(<TrainerCarousel trainers={TRAINERS} />);

    expect(raf).not.toHaveBeenCalled();
    expect(container.querySelectorAll("[data-dup]")).toHaveLength(0);
    // `.is-static` would wrap the track into a block, leaving nothing to swipe.
    expect(container.querySelector(".tr-scroll")?.className).not.toContain("is-static");
    raf.mockRestore();
  });

  it("clones but never starts a loop under prefers-reduced-motion", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    stubViewport({ reducedMotion: true });

    const { container } = render(<TrainerCarousel trainers={TRAINERS} />);

    expect(raf).not.toHaveBeenCalled();
    // The arrows still have somewhere to go, which is the acceptance criterion.
    expect(container.querySelectorAll('[data-dup="1"]').length).toBe(TRAINERS.length);
    expect(container.querySelectorAll("[data-tr]")).toHaveLength(2);
    raf.mockRestore();
  });
});

describe("trainer modal", () => {
  it("opens from a card with that trainer's name, location and photograph", () => {
    const { container } = render(<TrainerCarousel trainers={TRAINERS} />);
    const trainer = TRAINERS[2];

    const card = [...container.querySelectorAll(".tr-card:not([data-dup])")][2];
    fireEvent.click(card);

    const modal = container.querySelector("#tr-modal")!;
    expect(modal).toHaveAttribute("open");
    expect(modal).toHaveAttribute("role", "dialog");
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(modal).toHaveAttribute("aria-labelledby", "trm-name");

    expect(within(modal as HTMLElement).getByRole("heading", { name: trainer.name })).toBeInTheDocument();
    expect(modal.querySelector("#trm-loc")?.textContent).toBe(trainer.location);
    expect(modal.querySelector("#trm-img")).toHaveAttribute("src", trainer.photo);
  });

  it("keeps the client-signed-off placeholder note verbatim", () => {
    const { container } = render(<TrainerCarousel trainers={TRAINERS} />);
    fireEvent.click(container.querySelector(".tr-card")!);

    expect(container.querySelector(".trm-note")?.textContent).toBe(
      "On the live site this opens the trainer's own page, where you can see every horse they have nominated and follow the stable.",
    );
  });

  it("is closed, and renders no trainer, until a card is clicked", () => {
    const { container } = render(<TrainerCarousel trainers={TRAINERS} />);
    expect(container.querySelector("#tr-modal")).not.toHaveAttribute("open");
  });
});

describe("dialog shell — the focus contract", () => {
  /** The FAQ sheet is opened by a delegated `[data-sheet]` trigger anywhere. */
  function renderFaq() {
    const view = render(
      <>
        <button type="button" data-sheet="faq">
          View all
        </button>
        <MarketingFooter />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "View all" });
    trigger.focus();
    fireEvent.click(trigger);
    return { ...view, trigger };
  }

  it("opens the FAQ sheet from a delegated trigger and focuses its close button", () => {
    const { container } = renderFaq();
    const sheet = container.querySelector("#sheet-faq")!;

    expect(sheet).toHaveAttribute("open");
    expect(document.activeElement).toBe(sheet.querySelector("[data-close]"));
    expect(sheet.querySelectorAll("details")).toHaveLength(13);
  });

  it("closes on Escape and gives focus back to the trigger", () => {
    const { container, trigger } = renderFaq();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(container.querySelector("#sheet-faq")).not.toHaveAttribute("open");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on the close button and on a scrim click, and restores page scroll", () => {
    const { container, trigger } = renderFaq();
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(container.querySelector("#sheet-faq [data-close]")!);
    expect(container.querySelector("#sheet-faq")).not.toHaveAttribute("open");
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(trigger);

    // ...and again via the scrim, which is the overlay element itself.
    fireEvent.click(trigger);
    const sheet = container.querySelector("#sheet-faq")!;
    fireEvent.click(sheet);
    expect(sheet).not.toHaveAttribute("open");
  });

  /**
   * `aria-modal="true"` asserts the rest of the page is inert. The two dialogs
   * have different owners, so the invariant is enforced at module scope rather
   * than relying on the scrim to make a second trigger unclickable.
   */
  it("keeps only one dialog open at a time", () => {
    const { container } = render(
      <>
        <button type="button" data-sheet="faq">
          View all
        </button>
        <TrainerCarousel trainers={TRAINERS} />
        <MarketingFooter />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    expect(container.querySelector("#sheet-faq")).toHaveAttribute("open");

    fireEvent.click(container.querySelector(".tr-card:not([data-dup])")!);

    expect(container.querySelector("#tr-modal")).toHaveAttribute("open");
    expect(container.querySelector("#sheet-faq")).not.toHaveAttribute("open");
    expect(container.querySelectorAll("[open]")).toHaveLength(1);
  });

  /**
   * The handover's nastiest failure mode, and the reason the scroll lock is not
   * snapshotted per dialog.
   *
   * The incoming dialog reads `document.body.style.overflow` while the outgoing
   * one still has it `"hidden"`. Snapshot that per-dialog and it becomes the
   * value restored on close — so the page ends up permanently unscrollable with
   * no dialog open, and nothing on screen explains why.
   */
  it("restores page scrolling after a dialog hands over to another", () => {
    const { container } = render(
      <>
        <button type="button" data-sheet="faq">
          View all
        </button>
        <TrainerCarousel trainers={TRAINERS} />
        <MarketingFooter />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    expect(document.body.style.overflow).toBe("hidden");

    // Straight from one dialog to the other, without closing in between.
    fireEvent.click(container.querySelector(".tr-card:not([data-dup])")!);
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(container.querySelectorAll("[open]")).toHaveLength(0);
    expect(document.body.style.overflow, "the page was left scroll-locked").toBe("");
  });
});

describe("contact — a mailto, and nothing that looks like a send", () => {
  it("builds the href from the trigger's subject", () => {
    expect(contactMailtoHref("Trainer partnerships")).toBe(
      `mailto:${CONTACT_EMAIL}?subject=Trainer%20partnerships`,
    );
    expect(contactMailtoHref("General enquiry")).toBe(`mailto:${CONTACT_EMAIL}?subject=General%20enquiry`);
  });

  it("falls back to a bare mailto rather than an empty subject", () => {
    for (const subject of [undefined, null, "", "   "]) {
      expect(contactMailtoHref(subject)).toBe(`mailto:${CONTACT_EMAIL}`);
    }
  });

  it("points at the .co apex, never the third party on the .com", () => {
    expect(CONTACT_EMAIL).toMatch(/@stablepass\.co$/);
    expect(CONTACT_EMAIL).not.toContain(".com");
  });

  it("renders no contact form and no confirmation anywhere in the footer", () => {
    const { container } = render(<MarketingFooter />);

    expect(container.querySelector("form")).toBeNull();
    expect(container.querySelector("#sheet-contact")).toBeNull();
    expect(container.textContent).not.toMatch(/on its way|will be in touch/i);
  });
});

describe("footer — the two columns that became links", () => {
  it("points all four Legal entries at W4's real /legal routes", () => {
    const { container } = render(<MarketingFooter />);
    const legal = [...container.querySelectorAll<HTMLElement>(".foot-col")][2];

    expect([...within(legal).getAllByRole("link")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Privacy Policy", "/legal/privacy"],
      ["Terms & Conditions", "/legal/terms"],
      ["Cancellation & Refund Policy", "/legal/cancellation"],
      ["Acceptable Use Policy", "/legal/acceptable-use"],
    ]);

    // No button left in the column: with scripting off a button navigates nowhere.
    expect(within(legal).queryAllByRole("button")).toHaveLength(0);
  });

  it("turns the three Support contacts into mailto links carrying their subject", () => {
    const { container } = render(<MarketingFooter />);
    const support = [...container.querySelectorAll<HTMLElement>(".foot-col")][1];

    expect([...within(support).getAllByRole("link")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["FAQ", "#faq"],
      ["Contact us", contactMailtoHref("General enquiry")],
      ["Subscriber support", contactMailtoHref("Subscriber support")],
      ["Trainer partnerships", contactMailtoHref("Trainer partnerships")],
    ]);
    expect(within(support).queryAllByRole("button")).toHaveLength(0);
  });

  /**
   * The mockup prints no address so it cannot be scraped off the page. That
   * still holds — the address moved into the href, not into the copy.
   */
  it("still prints no email address in the visible copy", () => {
    const { container } = render(<MarketingFooter />);
    expect(container.textContent).not.toMatch(/@[\w.-]+\.\w+/);
  });
});
