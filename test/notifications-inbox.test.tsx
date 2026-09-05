import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotificationsInbox } from "@/app/(member)/notifications/notifications-inbox";

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

function envelope(data: unknown, meta?: unknown) {
  return { ok: true, status: 200, json: async () => (meta ? { data, meta } : { data }) };
}

function ROW(over: Record<string, unknown>) {
  return {
    id: "n1",
    type: "new_post",
    targetType: "horse",
    targetId: "h1",
    title: "New post",
    body: "Something happened",
    read: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("NotificationsInbox", () => {
  beforeEach(() => {
    pushMock.mockReset();
  });

  it("renders mobile's exact empty-state copy when the inbox is empty", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(envelope([], { hasMore: false }))));

    render(<NotificationsInbox />);

    await waitFor(() => expect(screen.getByTestId("notifications-empty")).toBeInTheDocument());
    expect(screen.getByText("No alerts yet")).toBeInTheDocument();
    expect(
      screen.getByText("Race-day reminders, results and new stable updates will appear here."),
    ).toBeInTheDocument();
  });

  it("gives unread rows the unread dot and read rows none", async () => {
    const rows = [ROW({ id: "n-unread", read: false }), ROW({ id: "n-read", read: true })];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(envelope(rows, { hasMore: false }))));

    render(<NotificationsInbox />);

    await waitFor(() => expect(screen.getByTestId("notifications-list")).toBeInTheDocument());
    expect(screen.getByTestId("notifications-unread-n-unread")).toBeInTheDocument();
    expect(screen.queryByTestId("notifications-unread-n-read")).toBeNull();
  });

  it("hides 'Mark all read' when everything is read", async () => {
    const rows = [ROW({ id: "n-read", read: true })];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(envelope(rows, { hasMore: false }))));

    render(<NotificationsInbox />);

    await waitFor(() => expect(screen.getByTestId("notifications-list")).toBeInTheDocument());
    expect(screen.queryByTestId("notifications-mark-all")).toBeNull();
  });

  it("shows 'Mark all read' when at least one row is unread", async () => {
    const rows = [ROW({ id: "n-unread", read: false })];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(envelope(rows, { hasMore: false }))));

    render(<NotificationsInbox />);

    await waitFor(() => expect(screen.getByTestId("notifications-mark-all")).toBeInTheDocument());
  });

  it("clicking an unread horse-target row PATCHes read:true and pushes /horses/:id", async () => {
    const user = userEvent.setup();
    const rows = [ROW({ id: "n1", targetType: "horse", targetId: "h1", read: false })];
    const fetchMock = vi.fn((url: string, _init?: RequestInit) => {
      if (String(url).startsWith("/api/notifications/n1")) {
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
      }
      return Promise.resolve(envelope(rows, { hasMore: false }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NotificationsInbox />);
    await waitFor(() => expect(screen.getByTestId("notifications-row-n1")).toBeInTheDocument());

    await user.click(screen.getByTestId("notifications-row-n1"));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/notifications/n1")).toBe(true),
    );
    const patchCall = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/notifications/n1")!;
    const init = patchCall[1] as RequestInit;
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ read: true });
    expect(pushMock).toHaveBeenCalledWith("/horses/h1");
  });

  it("clicking an unread post-target row PATCHes read:true but does NOT navigate (web fail-closed)", async () => {
    const user = userEvent.setup();
    const rows = [ROW({ id: "n2", targetType: "post", targetId: "p1", read: false })];
    const fetchMock = vi.fn((url: string) => {
      if (String(url).startsWith("/api/notifications/n2")) {
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
      }
      return Promise.resolve(envelope(rows, { hasMore: false }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NotificationsInbox />);
    await waitFor(() => expect(screen.getByTestId("notifications-row-n2")).toBeInTheDocument());

    await user.click(screen.getByTestId("notifications-row-n2"));

    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === "/api/notifications/n2")).toBe(true),
    );
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("renders 'Load more' only when meta.hasMore is true, and fetches with before= the oldest row's createdAt", async () => {
    const user = userEvent.setup();
    const rows = [
      ROW({ id: "n1", createdAt: "2026-02-01T00:00:00.000Z" }),
      ROW({ id: "n2", createdAt: "2026-01-01T00:00:00.000Z" }),
    ];
    const fetchMock = vi.fn((url: string) => {
      if (String(url).includes("before=")) {
        return Promise.resolve(envelope([], { hasMore: false }));
      }
      return Promise.resolve(envelope(rows, { hasMore: true }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NotificationsInbox />);
    await waitFor(() => expect(screen.getByTestId("notifications-load-more")).toBeInTheDocument());

    await user.click(screen.getByTestId("notifications-load-more"));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) =>
          String(c[0]).startsWith(`/api/notifications?before=${encodeURIComponent("2026-01-01T00:00:00.000Z")}`),
        ),
      ).toBe(true),
    );
  });

  it("does not render 'Load more' when meta.hasMore is false", async () => {
    const rows = [ROW({ id: "n1" })];
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(envelope(rows, { hasMore: false }))));

    render(<NotificationsInbox />);
    await waitFor(() => expect(screen.getByTestId("notifications-list")).toBeInTheDocument());
    expect(screen.queryByTestId("notifications-load-more")).toBeNull();
  });
});
