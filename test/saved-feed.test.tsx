import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SavedFeed } from "@/app/(member)/saved/saved-feed";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

// Bookmark rows pre-ordered newest-saved-first (as `.order(created_at desc)` returns
// them) — p1 saved after p2.
const BOOKMARKS = [
  { created_at: "2026-07-12T00:00:00.000Z", post: { id: "p1", horse_id: "h1", type: "photo", body: "Trackwork.", media_url: null, watermarked: false, like_count: 3, published_at: "2026-07-10T00:00:00.000Z" } },
  { created_at: "2026-07-11T00:00:00.000Z", post: { id: "p2", horse_id: "h2", type: "photo", body: "Paddock day.", media_url: null, watermarked: false, like_count: 1, published_at: "2026-07-09T00:00:00.000Z" } },
];
const HORSES = [
  { id: "h1", display_name: "Nature Strip", trainer: { name: "Chris Waller" } },
  { id: "h2", display_name: "Winx", trainer: { name: "Chris Waller" } },
];

// Per-test knobs.
let subStatus: string;
let bookmarkData: unknown[];
let bookmarkError: { message: string } | null;
let bookmarkDeleteError: { message: string } | null;

const { fromMock, upsertMock, orderMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  upsertMock: vi.fn(() => Promise.resolve({ error: null })),
  orderMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ from: fromMock }),
}));

// Generic chainable builder (subscription gate + horse/reaction enrichment).
function chainable(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "not", "order", "limit", "lt", "delete"]) obj[m] = vi.fn(() => obj);
  obj.maybeSingle = vi.fn(() => Promise.resolve(result));
  obj.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onF, onR);
  return obj;
}

// bookmark needs: a list read (select→lt→order→limit, thenable) that records the
// `.order` args, AND a delete().eq() write with its own resolvable error.
function bookmarkBuilder() {
  const listResult = { data: bookmarkData, error: bookmarkError };
  const obj: Record<string, unknown> = {};
  obj.select = vi.fn(() => obj);
  obj.lt = vi.fn(() => obj);
  obj.limit = vi.fn(() => obj);
  obj.order = vi.fn((...args: unknown[]) => { orderMock(...args); return obj; });
  obj.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(listResult).then(onF, onR);
  obj.delete = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: bookmarkDeleteError })) }));
  return obj;
}

beforeEach(() => {
  subStatus = "trial";
  bookmarkData = BOOKMARKS;
  bookmarkError = null;
  bookmarkDeleteError = null;
  fromMock.mockReset();
  upsertMock.mockClear();
  orderMock.mockClear();
  fromMock.mockImplementation((table: string) => {
    if (table === "subscription") return chainable({ data: { status: subStatus }, error: null });
    if (table === "bookmark") return bookmarkBuilder();
    if (table === "horse") return chainable({ data: HORSES, error: null });
    if (table === "reaction") {
      const c = chainable({ data: [], error: null });
      (c as unknown as { upsert: typeof upsertMock }).upsert = upsertMock;
      return c;
    }
    return chainable({ data: [], error: null });
  });
});

describe("SavedFeed", () => {
  it("renders the saved posts, newest-saved-first (query ordered by created_at desc)", async () => {
    render(<SavedFeed viewerId={VIEWER_ID} />);

    expect(await screen.findByText("Nature Strip")).toBeInTheDocument();
    expect(screen.getByText("Winx")).toBeInTheDocument();

    // The sort itself is pinned (not just the pre-ordered fixture).
    expect(orderMock).toHaveBeenCalledWith("created_at", { ascending: false });

    const names = screen.getAllByText(/Nature Strip|Winx/);
    expect(names[0]).toHaveTextContent("Nature Strip");
    expect(names[1]).toHaveTextContent("Winx");
  });

  it("unsave removes the card from the list", async () => {
    const user = userEvent.setup();
    render(<SavedFeed viewerId={VIEWER_ID} />);
    await screen.findByText("Nature Strip");

    // Every card is saved → its bookmark button is labelled "Remove bookmark".
    await user.click(screen.getAllByRole("button", { name: "Remove bookmark" })[0]);

    await waitFor(() => expect(screen.queryByText("Nature Strip")).not.toBeInTheDocument());
    expect(screen.getByText("Winx")).toBeInTheDocument();
  });

  it("restores the card if the unsave delete fails", async () => {
    bookmarkDeleteError = { message: "delete failed" };
    const user = userEvent.setup();
    render(<SavedFeed viewerId={VIEWER_ID} />);
    await screen.findByText("Nature Strip");

    await user.click(screen.getAllByRole("button", { name: "Remove bookmark" })[0]);

    // Optimistic remove, then restore-on-error → both cards remain.
    await waitFor(() => expect(screen.getByText("Nature Strip")).toBeInTheDocument());
    expect(screen.getByText("Winx")).toBeInTheDocument();
  });

  it("shows the empty state when there are no saved posts", async () => {
    bookmarkData = [];
    render(<SavedFeed viewerId={VIEWER_ID} />);

    expect(await screen.findByText(/saved any posts yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Nature Strip")).not.toBeInTheDocument();
  });

  it("shows the error state when the bookmark read fails", async () => {
    bookmarkError = { message: "boom" };
    render(<SavedFeed viewerId={VIEWER_ID} />);

    expect(await screen.findByText(/couldn.t load your saved posts/i)).toBeInTheDocument();
    expect(screen.queryByText("Nature Strip")).not.toBeInTheDocument();
  });

  it("shows the reactivate prompt when the subscription is lapsed (gated)", async () => {
    subStatus = "lapsed";
    render(<SavedFeed viewerId={VIEWER_ID} />);

    expect(await screen.findByText(/trial has ended/i)).toBeInTheDocument();
    expect(screen.queryByText("Nature Strip")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reactivate" })).toHaveAttribute("href", "/checkout");
  });
});
