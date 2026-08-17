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
let subRow: { status: string; trial_ends_at: string | null; current_period_end: string | null };
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
  // Not-gated default: an in-flight trial (future `trial_ends_at`) — matches the
  // pre-ENG-585 default of `subStatus = "trial"` under the old status-only check.
  subRow = { status: "trial", trial_ends_at: "2099-01-01T00:00:00.000Z", current_period_end: null };
  bookmarkData = BOOKMARKS;
  bookmarkError = null;
  bookmarkDeleteError = null;
  fromMock.mockReset();
  upsertMock.mockClear();
  orderMock.mockClear();
  fromMock.mockImplementation((table: string) => {
    if (table === "subscription") return chainable({ data: subRow, error: null });
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
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);

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
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    // Every card is saved → its bookmark button is labelled "Remove bookmark".
    await user.click(screen.getAllByRole("button", { name: "Remove bookmark" })[0]);

    await waitFor(() => expect(screen.queryByText("Nature Strip")).not.toBeInTheDocument());
    expect(screen.getByText("Winx")).toBeInTheDocument();
  });

  it("restores the card if the unsave delete fails", async () => {
    bookmarkDeleteError = { message: "delete failed" };
    const user = userEvent.setup();
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    await user.click(screen.getAllByRole("button", { name: "Remove bookmark" })[0]);

    // Optimistic remove, then restore-on-error → both cards remain.
    await waitFor(() => expect(screen.getByText("Nature Strip")).toBeInTheDocument());
    expect(screen.getByText("Winx")).toBeInTheDocument();
  });

  it("shows the empty state when there are no saved posts", async () => {
    bookmarkData = [];
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    expect(await screen.findByText(/saved any posts yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Nature Strip")).not.toBeInTheDocument();
  });

  it("shows the error state when the bookmark read fails", async () => {
    bookmarkError = { message: "boom" };
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    expect(await screen.findByText(/couldn.t load your saved posts/i)).toBeInTheDocument();
    expect(screen.queryByText("Nature Strip")).not.toBeInTheDocument();
  });

  it("shows the free-trial-ended wall when the subscription is lapsed (gated) and the member never subscribed", async () => {
    subRow = { status: "lapsed", trial_ends_at: null, current_period_end: null };
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    expect(await screen.findByText(/your free trial has ended/i)).toBeInTheDocument();
    expect(screen.queryByText("Nature Strip")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get full access" })).toHaveAttribute("href", "/checkout");
  });

  it("shows the access-paused wall when the subscription is lapsed (gated) and the member has subscribed before", async () => {
    subRow = { status: "lapsed", trial_ends_at: null, current_period_end: null };
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={true} />);

    expect(await screen.findByText(/your access has paused/i)).toBeInTheDocument();
    expect(screen.queryByText("Nature Strip")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy 30 days" })).toHaveAttribute("href", "/checkout");
  });

  describe("aspect ratio (ENG-612)", () => {
    const ratioOf = (el: HTMLElement): number => {
      const [w, h = "1"] = el.style.aspectRatio.split("/").map((part) => part.trim());
      return Number(w) / Number(h);
    };

    it("a 16:9 aspect_ratio (1.7778) renders the wide box unclamped", async () => {
      bookmarkData = [{ ...BOOKMARKS[0], post: { ...BOOKMARKS[0].post, aspect_ratio: 1.7778 } }];
      const { container } = render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
      await screen.findByText("Nature Strip");

      const box = container.querySelector<HTMLElement>(".post-media-web");
      expect(box).toBeTruthy();
      expect(ratioOf(box!)).toBeCloseTo(1.7778, 4);
      expect(box!.className).toBe("post-media-web");
    });

    it("a 9:16 reel aspect_ratio (0.5625) clamps to the tall bucket (ASPECT_MIN 0.8)", async () => {
      bookmarkData = [{ ...BOOKMARKS[0], post: { ...BOOKMARKS[0].post, aspect_ratio: 0.5625 } }];
      const { container } = render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
      await screen.findByText("Nature Strip");

      const box = container.querySelector<HTMLElement>(".post-media-web");
      expect(box).toBeTruthy();
      expect(ratioOf(box!)).toBeCloseTo(0.8, 4);
      expect(box!.className).toBe("post-media-web tall");
    });

    it("a null aspect_ratio falls back to ASPECT_DEFAULT (1.6)", async () => {
      bookmarkData = [{ ...BOOKMARKS[0], post: { ...BOOKMARKS[0].post, aspect_ratio: null } }];
      const { container } = render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
      await screen.findByText("Nature Strip");

      const box = container.querySelector<HTMLElement>(".post-media-web");
      expect(box).toBeTruthy();
      expect(ratioOf(box!)).toBeCloseTo(1.6, 4);
      expect(box!.className).toBe("post-media-web");
    });
  });
});
