import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReactionBar, REACTIONS } from "@/components/reaction-bar";

describe("ReactionBar", () => {
  it("renders exactly the 7 positive reaction glyphs + a bookmark button, and no comment affordance", () => {
    render(<ReactionBar count={0} reacted={null} bookmarked={false} onReact={vi.fn()} onBookmark={vi.fn()} />);

    expect(REACTIONS).toHaveLength(7);

    const group = screen.getByRole("group", { name: "React" });
    const reactionButtons = within(group).getAllByRole("button");
    expect(reactionButtons).toHaveLength(7);

    for (const r of REACTIONS) {
      expect(within(group).getByText(r.glyph)).toBeInTheDocument();
    }

    expect(screen.getByRole("button", { name: "Bookmark" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("calls onReact with the picked emoji key", async () => {
    const user = userEvent.setup();
    const onReact = vi.fn();
    render(<ReactionBar count={0} reacted={null} bookmarked={false} onReact={onReact} onBookmark={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Fire" }));

    expect(onReact).toHaveBeenCalledWith("fire");
  });

  it("calls onBookmark when the bookmark button is clicked", async () => {
    const user = userEvent.setup();
    const onBookmark = vi.fn();
    render(<ReactionBar count={0} reacted={null} bookmarked={false} onReact={vi.fn()} onBookmark={onBookmark} />);

    await user.click(screen.getByRole("button", { name: "Bookmark" }));

    expect(onBookmark).toHaveBeenCalledTimes(1);
  });
});
