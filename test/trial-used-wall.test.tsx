import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { TrialUsedWall } from "@/app/start/trial-used-wall";

// The repeat-signup wall (ENG-763). One component, rendered by app/start/page.tsx
// for `/start?trial=used` — which is both what the form navigates to after a 409
// and what a visitor with JavaScript blocked gets as plain server HTML.
describe("TrialUsedWall", () => {
  it("leads with the friendly headline, not an error", () => {
    render(<TrialUsedWall />);

    expect(
      screen.getByRole("heading", { name: /Looks like you.ve already had your free trial/i }),
    ).toBeInTheDocument();

    // Tone is the requirement here, not just presence: this copy is
    // Justin-visible and must not read as an accusation or a rejection.
    const text = document.body.textContent ?? "";
    for (const accusatory of ["denied", "not allowed", "invalid", "error", "cannot", "refused"]) {
      expect(text.toLowerCase()).not.toContain(accusatory);
    }
  });

  it("gives a real next step: a join prompt and a CTA that reaches sign-in", () => {
    render(<TrialUsedWall />);

    // The acceptance criterion is that the CTA REACHES sign-in, so assert the
    // destination rather than just the label.
    expect(screen.getByRole("link", { name: "Sign in to join" })).toHaveAttribute(
      "href",
      "/signin",
    );
    expect(screen.getByText(/\$19 per month/)).toBeInTheDocument();
  });

  it("leaves a way back for someone who simply mistyped", () => {
    render(<TrialUsedWall />);

    expect(screen.getByRole("link", { name: "Start over" })).toHaveAttribute("href", "/start");
  });

  it("renders as real links, so it works with JavaScript blocked", () => {
    // The whole reason this is a server-rendered component: the reviewer's phone
    // blocks scripting, and a wall whose only exit is an onClick is a dead end
    // there. next/link still emits a real href, which is what this pins.
    const { container } = render(<TrialUsedWall />);

    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/signin", "/start"]);
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("adds no new CSS classes — every class already exists in globals.css", () => {
    // marketing.css is diffed rule-for-rule against the mockup and globals.css
    // is contended by a parallel ticket, so this wall was built to need neither.
    // These are the classes the 03-trial-start mockup itself uses.
    const { container } = render(<TrialUsedWall />);

    const classes = new Set<string>();
    container.querySelectorAll("*").forEach((el) => {
      el.classList.forEach((c) => classes.add(c));
    });

    expect(classes).toEqual(
      new Set([
        "auth-card",
        "auth-sub",
        "trial-banner-web",
        "trial-label",
        "trial-detail",
        "btn",
        "btn-primary",
        "btn-block",
        "btn-large",
        "auth-foot",
      ]),
    );
  });

  it("does not offer the free trial it has just said is used up", () => {
    // The ENG-729 defect class, pinned at the component level: a wall that also
    // pitches the trial is the exact bug that shipped an hour before this
    // ticket. The screen-level half of this lives in the touch e2e spec.
    render(<TrialUsedWall />);
    const text = document.body.textContent ?? "";

    expect(text).not.toMatch(/30 days on us/i);
    expect(text).not.toMatch(/no credit card/i);
    expect(text).not.toMatch(/start free trial/i);
    // It may of course say the trial is already HAD — that is the message.
    expect(text).toMatch(/already had your free trial/i);
  });
});
