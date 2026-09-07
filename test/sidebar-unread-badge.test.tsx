import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { Sidebar, type SidebarUser } from "@/app/(member)/sidebar";
import { UNREAD_CHANGED_EVENT } from "@/app/api/notifications/contract";

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

function mockUnreadCount(response: { ok: boolean; unread?: number; reject?: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      if (response.reject) return Promise.reject(new Error("network down"));
      return Promise.resolve({
        ok: response.ok,
        status: response.ok ? 200 : 500,
        json: async () => ({ data: { unread: response.unread ?? 0 } }),
      });
    }),
  );
}

describe("Sidebar unread badge (ENG-957)", () => {
  it("renders the sidebar-unread-badge chip with the count when unread-count returns 3", async () => {
    mockUnreadCount({ ok: true, unread: 3 });
    render(<Sidebar user={USER} />);

    await waitFor(() => expect(screen.getByTestId("sidebar-unread-badge")).toBeInTheDocument());
    expect(screen.getByTestId("sidebar-unread-badge").textContent).toBe("3");
  });

  it("renders no chip when the count is 0", async () => {
    mockUnreadCount({ ok: true, unread: 0 });
    render(<Sidebar user={USER} />);

    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("sidebar-unread-badge")).toBeNull();
  });

  it("renders no chip when the fetch rejects — must not render '0'", async () => {
    mockUnreadCount({ ok: true, reject: true });
    render(<Sidebar user={USER} />);

    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("sidebar-unread-badge")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
  });

  it("renders no chip when the fetch resolves non-ok — must not render '0'", async () => {
    mockUnreadCount({ ok: false, unread: 3 });
    render(<Sidebar user={USER} />);

    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
    expect(screen.queryByTestId("sidebar-unread-badge")).toBeNull();
  });

  it("renders the chip on the /notifications nav item, not on another item", async () => {
    mockUnreadCount({ ok: true, unread: 5 });
    const { container } = render(<Sidebar user={USER} />);

    await waitFor(() => expect(screen.getByTestId("sidebar-unread-badge")).toBeInTheDocument());
    const notificationsLink = container.querySelector('a[href="/notifications"]');
    expect(notificationsLink?.querySelector('[data-testid="sidebar-unread-badge"]')).toBeTruthy();

    const otherLinks = Array.from(container.querySelectorAll(".sidebar-nav a")).filter(
      (a) => a.getAttribute("href") !== "/notifications",
    );
    for (const a of otherLinks) {
      expect(a.querySelector('[data-testid="sidebar-unread-badge"]')).toBeNull();
    }
  });

  // ── GAP 3 (fresh-eyes review) — "refreshed on navigation" is a ticket
  // acceptance criterion. `pathname` was declared mutable but never actually
  // changed anywhere in this file, so the `[pathname, revision]` effect
  // dependency was never exercised.
  it("re-fetches the unread count when pathname changes (navigation), and the chip reflects the new value", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { unread: 2 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { unread: 0 } }) });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<Sidebar user={USER} />);

    await waitFor(() => expect(screen.getByTestId("sidebar-unread-badge").textContent).toBe("2"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pathname = "/notifications";
    rerender(<Sidebar user={USER} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("sidebar-unread-badge")).toBeNull());
  });

  // ── GAP 4 (fresh-eyes review) — the UNREAD_CHANGED_EVENT listener had no
  // unit test. "Mark all read" fires this event WITHOUT navigating, so the
  // chip must re-fetch off the event alone.
  it("re-fetches the unread count when UNREAD_CHANGED_EVENT fires, without navigation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { unread: 3 } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { unread: 0 } }) });
    vi.stubGlobal("fetch", fetchMock);

    render(<Sidebar user={USER} />);

    await waitFor(() => expect(screen.getByTestId("sidebar-unread-badge").textContent).toBe("3"));

    await act(async () => {
      window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("sidebar-unread-badge")).toBeNull());
  });

  it("removes the UNREAD_CHANGED_EVENT listener on unmount — no further fetch after unmount", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { unread: 3 } }) });
    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<Sidebar user={USER} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    unmount();

    await act(async () => {
      window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
