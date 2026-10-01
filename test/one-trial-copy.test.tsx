import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import FaqSheet from "@/app/(marketing)/modals/faq-sheet";
import Faq from "@/app/(marketing)/sections/faq";
import Pricing from "@/app/(marketing)/sections/pricing";

/**
 * ENG-1707 (TG-W1). A member gets ONE free trial in total — across the web, the
 * App Store and Google Play, and across delete-and-re-register with the same email
 * (TG-B1 / TG-M1). Before this ticket the marketing copy promised "30 days free …
 * the same on the App Store and Google Play" with no limit, which reads as one
 * trial per channel. Owner decision (1 Oct 2026): say the limit on the FAQ and the
 * pricing card.
 *
 * Pinned in all three components that state the trial: the FAQ section, the full
 * FAQ sheet (a separate copy of the list, deliberately not shared), and the price card.
 */

const FAQ_SENTENCE =
  "The free trial is for new members — one per member, whether you start it on the web, the App Store or Google Play.";
const PRICING_LINE = "New members only · one free trial per member.";

function costAnswer(root: ParentNode): string | null | undefined {
  const cost = [...root.querySelectorAll("details")].find((d) =>
    d.querySelector("summary")?.textContent?.includes("How much does stablepass. cost?"),
  );
  return cost?.querySelector("p.a")?.textContent;
}

describe("one free trial per member — marketing copy", () => {
  it("FAQ section: the cost answer ends with the one-trial sentence", () => {
    const { container } = render(<Faq />);
    const answer = costAnswer(container.querySelector("#faq")!);
    expect(answer, "the FAQ section no longer answers what stablepass. costs").toBeTruthy();
    expect(answer!.endsWith(FAQ_SENTENCE)).toBe(true);
  });

  it("FAQ sheet: the cost answer ends with the same sentence", () => {
    const { container } = render(
      <>
        <button type="button" data-sheet="faq">
          View all
        </button>
        <FaqSheet />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    const answer = costAnswer(container.querySelector("#sheet-faq")!);
    expect(answer, "the FAQ sheet no longer answers what stablepass. costs").toBeTruthy();
    expect(answer!.endsWith(FAQ_SENTENCE)).toBe(true);
  });

  it("pricing card: the qualifier sits directly under the trial line", () => {
    const { container } = render(<Pricing />);
    const card = container.querySelector("#subscription .price-card")!;
    const launch = card.querySelector(".price-launch")!;
    expect(launch.textContent).toBe("Start with 30 days free.");

    const intros = [...card.querySelectorAll(".price-intro")].map((p) => p.textContent);
    expect(intros).toEqual(["Then A$9.99 per month. Cancel anytime. No lock-in contract.", PRICING_LINE]);
    // Beside the trial, not buried in the fine print at the foot of the card.
    expect(launch.nextElementSibling?.nextElementSibling?.textContent).toBe(PRICING_LINE);
  });
});
