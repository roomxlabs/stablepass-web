import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Sidebar, type SidebarUser } from "@/app/(member)/sidebar";

let pathname = "/explore";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ auth: { signOut: vi.fn(async () => ({})) } }),
}));

const USER: SidebarUser = {
  name: "Member Test",
  email: "member@stable.com",
  initial: "M",
  trialLabel: "Trial · 30 days left",
};

beforeEach(() => {
  pathname = "/explore";
});

describe("Sidebar brand", () => {
  it("renders the real wordmark as a masked element, not a styled text node", () => {
    const { container } = render(<Sidebar user={USER} />);
    const wordmark = container.querySelector(".sidebar-logo .wordmark");
    expect(wordmark).toBeTruthy();
    // The square S. mark ships alongside it for the collapsed rail.
    expect(container.querySelector(".sidebar-logo .brandmark")).toBeTruthy();
  });

  it("keeps the brand name in the DOM for assistive tech", () => {
    const { container } = render(<Sidebar user={USER} />);
    const sr = container.querySelector(".sidebar-logo .sr-only");
    expect(sr?.textContent).toBe("stablepass.");
  });
});

describe("Sidebar nav icons", () => {
  it("gives Horses a horseshoe with flared tips, not the old open arc", () => {
    const { container } = render(<Sidebar user={USER} />);
    const svg = container.querySelector('a[href="/horses"] svg.ic');
    expect(svg).toBeTruthy();
    // The tell: the old glyph was a single arc <path>. The horseshoe is the U band
    // plus a second path carrying both heel calkins, and no stray dots at 18px.
    expect(svg?.querySelectorAll("path").length).toBe(2);
    expect(svg?.querySelectorAll("circle").length).toBe(0);
  });

  it("gives Account a person inside a ring, distinct from the Trainers person", () => {
    const { container } = render(<Sidebar user={USER} />);
    const account = container.querySelector('a[href="/account"] svg.ic');
    const trainers = container.querySelector('a[href="/trainers"] svg.ic');
    // Ring + head = two circles; Trainers is head-only.
    expect(account?.querySelectorAll("circle").length).toBe(2);
    expect(trainers?.querySelectorAll("circle").length).toBe(1);
  });

  it("labels every nav item so the collapsed rail stays readable to screen readers", () => {
    const { container } = render(<Sidebar user={USER} />);
    const links = Array.from(container.querySelectorAll(".sidebar-nav a"));
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.querySelector(".nav-label")?.textContent?.trim()).toBeTruthy();
      // title drives the hover tooltip once labels go sr-only in the rail.
      expect(a.getAttribute("title")).toBeTruthy();
    }
  });

  it("marks the active route with aria-current", () => {
    pathname = "/horses";
    const { container } = render(<Sidebar user={USER} />);
    expect(container.querySelector('a[href="/horses"]')?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('a[href="/explore"]')?.getAttribute("aria-current")).toBeNull();
  });
});

describe("Sidebar drawer", () => {
  it("starts closed", () => {
    const { container } = render(<Sidebar user={USER} />);
    expect(screen.getByRole("button", { name: "Open navigation" })).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".sidebar")?.className).not.toContain("open");
    expect(screen.queryByTestId("sidebar-backdrop")).toBeNull();
  });

  it("opens on the hamburger and renders a backdrop", () => {
    const { container } = render(<Sidebar user={USER} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(container.querySelector(".sidebar")?.className).toContain("open");
    expect(screen.getByTestId("sidebar-backdrop")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close navigation" })).toHaveAttribute("aria-expanded", "true");
  });

  it("closes when the backdrop is clicked", () => {
    const { container } = render(<Sidebar user={USER} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByTestId("sidebar-backdrop"));
    expect(container.querySelector(".sidebar")?.className).not.toContain("open");
  });

  it("closes on Escape", () => {
    const { container } = render(<Sidebar user={USER} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".sidebar")?.className).not.toContain("open");
  });

  it("closes when the route changes, so it never covers the page just opened", () => {
    const { container, rerender } = render(<Sidebar user={USER} />);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(container.querySelector(".sidebar")?.className).toContain("open");

    pathname = "/saved";
    rerender(<Sidebar user={USER} />);
    expect(container.querySelector(".sidebar")?.className).not.toContain("open");
  });

  it("wires the toggle to the sidebar it controls", () => {
    const { container } = render(<Sidebar user={USER} />);
    const toggle = screen.getByRole("button", { name: "Open navigation" });
    expect(toggle.getAttribute("aria-controls")).toBe("member-sidebar");
    expect(container.querySelector("#member-sidebar")).toBeTruthy();
  });
});
