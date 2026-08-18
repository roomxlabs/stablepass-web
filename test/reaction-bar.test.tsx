import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReactionBar, REACTIONS } from "@/components/reaction-bar";

// jsdom does not apply real stylesheets, so the visual contract (which state paints
// what) is asserted against the stylesheet source itself.
const readGlobalsCss = () => readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

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

describe("ReactionBar — reacted state is visible at rest", () => {
  it("marks only the picked chip with .on and aria-pressed", () => {
    const { container } = render(
      <ReactionBar count={3} reacted="fire" bookmarked={false} onReact={vi.fn()} onBookmark={vi.fn()} />,
    );
    const on = container.querySelectorAll(".reactions-web button.on");
    expect(on).toHaveLength(1);
    expect(on[0].getAttribute("aria-label")).toBe("Fire");
    expect(screen.getByRole("button", { name: "Fire" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Like" })).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the glyph wrapper a bare span so it cannot paint over the selected fill", () => {
    const { container } = render(
      <ReactionBar count={0} reacted="like" bookmarked={false} onReact={vi.fn()} onBookmark={vi.fn()} />,
    );
    // Regression guard: the glyph span used to share the button's rule and drew its
    // own opaque white circle on top of `.on`'s green background.
    const rule = readGlobalsCss();
    expect(rule).not.toMatch(/\.reactions-web button,\s*\.reactions-web span\s*\{/);
    expect(rule).toMatch(/\.reactions-web button > span\s*\{[^}]*background:\s*none/);
    expect(container.querySelector(".reactions-web button.on > span")).toBeTruthy();
  });

  it("no longer overlaps the chips, which read as cramped", () => {
    expect(readGlobalsCss()).not.toMatch(/\.reactions-web\s*\{[^}]*margin-left:\s*-4px/);
  });
});

describe("ReactionBar — saved state and confirmation", () => {
  it("labels the button Save when unsaved and Saved once saved", () => {
    const { rerender } = render(
      <ReactionBar count={0} reacted={null} bookmarked={false} onReact={vi.fn()} onBookmark={vi.fn()} />,
    );
    expect(screen.getByText("Save")).toBeInTheDocument();

    rerender(<ReactionBar count={0} reacted={null} bookmarked onReact={vi.fn()} onBookmark={vi.fn()} />);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove bookmark" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does not inline-style the icon fill, which would outrank the stylesheet", () => {
    const { container } = render(
      <ReactionBar count={0} reacted={null} bookmarked onReact={vi.fn()} onBookmark={vi.fn()} />,
    );
    const icon = container.querySelector(".action-web.bookmarked .ic") as SVGElement | null;
    expect(icon).toBeTruthy();
    // The bug: style={{ fill: "currentColor" }} beat `.bookmarked .ic { fill: green }`,
    // and `.bookmarked` set no colour, so "saved" painted muted grey.
    expect(icon!.getAttribute("style")).toBeNull();
    expect(readGlobalsCss()).toMatch(/\.action-web\.bookmarked\s*\{[^}]*color:\s*var\(--brand-green\)/);
  });

  it("confirms an add with a transient toast", async () => {
    const user = userEvent.setup();
    render(<ReactionBar count={0} reacted={null} bookmarked={false} onReact={vi.fn()} onBookmark={vi.fn()} />);

    expect(screen.queryByTestId("saved-toast")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Bookmark" }));
    expect(screen.getByTestId("saved-toast")).toHaveTextContent("Saved to your stable");
    expect(screen.getByTestId("saved-toast")).toHaveAttribute("role", "status");
  });

  it("stays quiet when REMOVING a bookmark — a toast there would read as an error", async () => {
    const user = userEvent.setup();
    render(<ReactionBar count={0} reacted={null} bookmarked onReact={vi.fn()} onBookmark={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Remove bookmark" }));
    expect(screen.queryByTestId("saved-toast")).toBeNull();
  });
});

describe("post card spacing", () => {
  // SUPERSEDED BY ENG-613. This used to pin the two adjacent-sibling rules
  // (`.post-media-web + .post-actions-web`, `.post-head-web + .post-actions-web`)
  // that gave the row its top padding only when no caption preceded it. The
  // caption now renders BELOW this row, so neither selector describes the order
  // any more and both were removed; the padding is unconditional instead. The
  // behaviour under test is unchanged and still asserted — an uncaptioned post
  // is spaced exactly like a captioned one — only the mechanism moved.
  it("pads the actions row unconditionally, so a captionless post is spaced the same", () => {
    const css = readGlobalsCss().replace(/\/\*[\s\S]*?\*\//g, "");

    const rules = css.match(/^\.post-actions-web\s*\{[^}]*\}/gm) ?? [];
    const withPadding = rules.filter((r) => r.includes("padding:"));
    expect(withPadding).toHaveLength(1);
    expect(withPadding[0]).toMatch(/padding:\s*14px 22px 18px/);

    // The old conditional mechanism must be gone, not merely overridden.
    expect(css).not.toContain(".post-media-web + .post-actions-web");
    expect(css).not.toContain(".post-head-web + .post-actions-web");
  });

  it("anchors the toast above the actions row so it cannot cover the chips", () => {
    const css = readGlobalsCss();
    expect(css).toMatch(/\.post-actions-web\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.post-toast-web\s*\{[^}]*bottom:\s*calc\(100% - 6px\)/);
  });
});
