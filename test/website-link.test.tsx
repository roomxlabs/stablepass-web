import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WebsiteLink } from "@/app/(member)/trainers/[id]/website-link";

const TRAINER_ID = "3f1c9b2e-5a4d-4c8b-9e7a-1d2b3c4d5e6f";

describe("WebsiteLink", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing when the trainer has no website_url", () => {
    const { container } = render(<WebsiteLink trainerId={TRAINER_ID} websiteUrl={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders nothing when website_url is blank/whitespace", () => {
    const { container } = render(<WebsiteLink trainerId={TRAINER_ID} websiteUrl="   " />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a scheme-less URL (would otherwise become a broken relative href)", () => {
    // A bare domain is a very likely admin input — `website_url` has no CHECK
    // constraint. Rendering it raw would resolve to /trainers/<id>/wallerracing.com.au.
    const { container } = render(<WebsiteLink trainerId={TRAINER_ID} websiteUrl="wallerracing.com.au" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("GUARDRAIL: renders nothing for a non-http(s) scheme (javascript:/data:)", () => {
    for (const hostile of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>"]) {
      const { container } = render(<WebsiteLink trainerId={TRAINER_ID} websiteUrl={hostile} />);
      expect(container).toBeEmptyDOMElement();
    }
  });

  it("renders the anchor with the trainer's URL and safe new-tab attributes", () => {
    render(<WebsiteLink trainerId={TRAINER_ID} websiteUrl="https://wallerracing.example" />);

    const link = screen.getByRole("link", { name: /website/i });
    expect(link).toHaveAttribute("href", "https://wallerracing.example");
    expect(link).toHaveAttribute("target", "_blank");
    // noopener+noreferrer: the opened tab must not get a window.opener handle.
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // Styled as a secondary profile action, matching the Notify button.
    expect(link).toHaveClass("btn", "btn-light");
  });

  it("POSTs the click to the BFF on click", async () => {
    const user = userEvent.setup();
    render(<WebsiteLink trainerId={TRAINER_ID} websiteUrl="https://wallerracing.example" />);

    await user.click(screen.getByRole("link", { name: /website/i }));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`/api/trainers/${TRAINER_ID}/website-click`);
    expect((init as RequestInit).method).toBe("POST");
  });

  it("logs a middle-click (opens in a new tab without ever firing onClick)", async () => {
    const user = userEvent.setup();
    render(<WebsiteLink trainerId={TRAINER_ID} websiteUrl="https://wallerracing.example" />);

    await user.pointer({
      keys: "[MouseMiddle]",
      target: screen.getByRole("link", { name: /website/i }),
    });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT log a right-click (opening the context menu is not a visit)", async () => {
    const user = userEvent.setup();
    render(<WebsiteLink trainerId={TRAINER_ID} websiteUrl="https://wallerracing.example" />);

    // auxclick fires for any non-primary button, so an unguarded onAuxClick
    // would count "Copy link address" as a click-through that never happened.
    await user.pointer({
      keys: "[MouseRight]",
      target: screen.getByRole("link", { name: /website/i }),
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("GUARDRAIL: sends no user identity in the click request (server derives it)", async () => {
    const user = userEvent.setup();
    render(<WebsiteLink trainerId={TRAINER_ID} websiteUrl="https://wallerracing.example" />);

    await user.click(screen.getByRole("link", { name: /website/i }));

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((init as RequestInit).body).toBeUndefined();
  });

  // Scope note: jsdom never navigates, so this pins only that a rejected log is
  // swallowed rather than thrown. That navigation itself is never blocked is
  // proven by the A2 Playwright test, which asserts the real popup opens.
  it("swallows a failing click log instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const user = userEvent.setup();
    render(<WebsiteLink trainerId={TRAINER_ID} websiteUrl="https://wallerracing.example" />);

    // The click must resolve cleanly even though the log rejected.
    await expect(
      user.click(screen.getByRole("link", { name: /website/i })),
    ).resolves.not.toThrow();
    expect(screen.getByRole("link", { name: /website/i })).toBeInTheDocument();
  });
});
