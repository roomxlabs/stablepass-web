import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShowMoreButton } from "@/components/show-more-button";

// ENG-1038 — the pager control extracted from the third copy of it.
//
// Covered directly rather than only through /shares, because ENG-1042 will
// point the Horses and Trainers grids at this same component: at that moment
// the three-way label becomes shared behaviour on three surfaces, and a
// regression here breaks all of them at once. Cheap insurance, written now
// while the reasoning is fresh.
describe("ShowMoreButton (ENG-1038)", () => {
  it("labels the three states, and disables ONLY while a fetch is in flight", async () => {
    const { rerender } = render(
      <ShowMoreButton loadingMore={false} pageError={false} onClick={() => {}} />,
    );
    expect(screen.getByRole("button")).toHaveTextContent("Show more");
    expect(screen.getByRole("button")).toBeEnabled();

    // In flight: disabled, so a double-click cannot fire two fetches at the
    // same offset — which would append the same page twice.
    rerender(<ShowMoreButton loadingMore pageError={false} onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("Loading…");
    expect(screen.getByRole("button")).toBeDisabled();

    // After a failed page the roster is KEPT, so the button must stay clickable
    // — it is the only way back on a surface with no filter pills.
    rerender(<ShowMoreButton loadingMore={false} pageError onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("Try again");
    expect(screen.getByRole("button")).toBeEnabled();

    // `loadingMore` wins over `pageError`: a retry already in flight reads as
    // "Loading…", not as a still-failed "Try again".
    rerender(<ShowMoreButton loadingMore pageError onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveTextContent("Loading…");
  });

  it("fires onClick when live and NEVER while loading", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup({ delay: null });

    const { rerender } = render(
      <ShowMoreButton loadingMore={false} pageError={false} onClick={onClick} />,
    );
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<ShowMoreButton loadingMore pageError={false} onClick={onClick} />);
    await user.click(screen.getByRole("button"));
    // Still 1 — the disabled attribute is load-bearing, not decorative.
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is a type=button so it can never submit an enclosing form", () => {
    render(<ShowMoreButton loadingMore={false} pageError={false} onClick={() => {}} />);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });
});
