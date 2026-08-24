// ENG-613 (W2) row 5 — the Follow pill. Net-new in this repo; the same component
// and the same corner as mobile's M3.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FollowPill } from "@/components/follow-pill";

describe("FollowPill", () => {
  it("reads `Follow` and carries the stylesheet hook the design source names", () => {
    render(<FollowPill trainerName="Chris Waller" />);

    const pill = screen.getByRole("button", { name: "Follow Chris Waller" });
    expect(pill).toHaveTextContent("Follow");
    expect(pill).toHaveClass("media-follow");
  });

  // There is no "Following" variant anywhere in this design — a followed trainer
  // simply gets no pill — so the label is a constant, not a state readout.
  it("never offers a `Following` state", () => {
    render(<FollowPill trainerName="Chris Waller" />);
    expect(screen.queryByText(/following/i)).not.toBeInTheDocument();
  });

  // Several cards by different trainers share one page, so "Follow" alone would
  // give every pill the same accessible name.
  it("names the trainer in its accessible label", () => {
    render(<FollowPill trainerName="Peter Moody" />);
    expect(screen.getByRole("button", { name: "Follow Peter Moody" })).toBeInTheDocument();
  });

  it("hands the click to the screen, which owns the write", async () => {
    const onFollow = vi.fn();
    render(<FollowPill trainerName="Chris Waller" onFollow={onFollow} />);

    await userEvent.click(screen.getByRole("button", { name: "Follow Chris Waller" }));
    expect(onFollow).toHaveBeenCalledTimes(1);
  });

  // A submit-type button inside a form would navigate. It is rendered inside a
  // media box today, but the default is the kind of thing that bites later.
  it("is an explicit non-submit button", () => {
    render(<FollowPill trainerName="Chris Waller" />);
    expect(screen.getByRole("button", { name: "Follow Chris Waller" })).toHaveAttribute("type", "button");
  });
});
