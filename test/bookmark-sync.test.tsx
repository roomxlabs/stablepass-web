// ENG-961 — proves the cross-surface bookmark sync module is actually WIRED
// INTO the screens (not just correct in isolation — that's bookmark-store.test.ts).
// This fails if a screen drops its `subscribeBookmarkChanges` effect or stops
// calling `emitBookmarkChange` on a confirmed write.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SavedFeed } from "@/app/(member)/saved/saved-feed";
import { ExploreFeed } from "@/app/(member)/explore/explore-feed";
import { emitBookmarkChange, subscribeBookmarkChanges, resetBookmarkListeners } from "@/lib/feed/bookmark-store";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

// ===========================================================================
// SavedFeed harness — copied verbatim from test/saved-feed.test.tsx.
// ===========================================================================
const BOOKMARKS = [
  { created_at: "2026-07-12T00:00:00.000Z", post: { id: "p1", horse_id: "h1", type: "photo", body: "Trackwork.", media_url: null, watermarked: false, like_count: 3, published_at: "2026-07-10T00:00:00.000Z" } },
  { created_at: "2026-07-11T00:00:00.000Z", post: { id: "p2", horse_id: "h2", type: "photo", body: "Paddock day.", media_url: null, watermarked: false, like_count: 1, published_at: "2026-07-09T00:00:00.000Z" } },
];
const HORSES = [
  { id: "h1", display_name: "Nature Strip", trainer: { name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill" } },
  { id: "h2", display_name: "Winx", trainer: { name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill" } },
];

let subRow: { status: string; trial_ends_at: string | null; current_period_end: string | null };
let bookmarkData: unknown[];
let bookmarkError: { message: string } | null;
let bookmarkDeleteError: { message: string } | null;

const { fromMock, upsertMock, orderMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  upsertMock: vi.fn(() => Promise.resolve({ error: null })),
  orderMock: vi.fn(),
}));

// A SINGLE mock of the module — both SavedFeed and ExploreFeed below resolve
// `supabaseBrowser()` through this one `fromMock`, re-armed per describe's
// own `beforeEach`. (`vi.mock` may only be registered once per module id per
// test file.)
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    from: fromMock,
    storage: {
      from: () => ({
        createSignedUrls: (paths: string[]) =>
          Promise.resolve({ data: paths.map((path) => ({ path, signedUrl: `https://sb.local/signed/${path}` })) }),
      }),
    },
  }),
}));

function chainable(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "not", "order", "limit", "lt", "delete"]) obj[m] = vi.fn(() => obj);
  obj.maybeSingle = vi.fn(() => Promise.resolve(result));
  obj.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onF, onR);
  return obj;
}

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
  resetBookmarkListeners();

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
  global.fetch = vi.fn((input: string | URL) => {
    const url = String(input);
    if (url === "/api/posts/media" || url.startsWith("/api/posts/media?")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              { postId: "p1", mediaUrl: "https://sb.local/p1?token=abc" },
              { postId: "p2", mediaUrl: "https://sb.local/p2?token=abc" },
            ],
            expiresAt: "2026-08-01T00:00:00.000Z",
          },
        }),
      });
    }
    if (url.includes("/playback?posterOnly=1")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: { posterUrl: "https://sb.local/poster?token=abc", expiresAt: "2026-08-01T00:00:00.000Z" } }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
  }) as unknown as typeof fetch;
});

describe("SavedFeed — cross-surface bookmark sync (ENG-961)", () => {
  it("Saved drops a card when the post is unsaved on another screen", async () => {
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    await screen.findByText("Trackwork.");
    expect(screen.getByText("Paddock day.")).toBeInTheDocument();

    act(() => {
      emitBookmarkChange("p1", false);
    });

    expect(screen.queryByText("Trackwork.")).not.toBeInTheDocument();
    expect(screen.getByText("Paddock day.")).toBeInTheDocument();
  });

  it("unsaving ON Saved notifies the other screens", async () => {
    const listener = vi.fn();
    subscribeBookmarkChanges(listener);

    const user = userEvent.setup();
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Trackwork.");

    // Every card on Saved is saved → its bookmark button is "Remove bookmark".
    await user.click(screen.getAllByRole("button", { name: "Remove bookmark" })[0]);

    await waitFor(() => expect(listener).toHaveBeenCalledWith("p1", false));
  });

  it("a FAILED unsave does NOT notify", async () => {
    bookmarkDeleteError = { message: "nope" };
    const listener = vi.fn();
    subscribeBookmarkChanges(listener);

    const user = userEvent.setup();
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Trackwork.");

    await user.click(screen.getAllByRole("button", { name: "Remove bookmark" })[0]);

    // Optimistic remove, then restore-on-error — wait for the restore to settle
    // before asserting the listener was never reached.
    await waitFor(() => expect(screen.getByText("Trackwork.")).toBeInTheDocument());
    expect(listener).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// ExploreFeed harness — copied verbatim from test/explore-feed.test.tsx.
// ===========================================================================
const EXPLORE_POSTS = [
  {
    id: "p1",
    horse_id: "h1",
    type: "photo",
    body: "Trackwork this morning.",
    media_url: null,
    watermarked: false,
    like_count: 12,
    published_at: "2026-07-10T00:00:00.000Z",
  },
  {
    id: "p2",
    horse_id: "h2",
    type: "photo",
    body: "Recovery day in the paddock.",
    media_url: null,
    watermarked: false,
    like_count: 5,
    published_at: "2026-07-11T00:00:00.000Z",
  },
];

const EXPLORE_HORSES = [
  { id: "h1", display_name: "Mahogany", trainer: { name: "Chris Waller" } },
  { id: "h2", display_name: "Winx", trainer: { name: "Chris Waller" } },
];

function exploreChainable(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.delete = vi.fn(() => obj);
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

function exploreFetchImpl() {
  return vi.fn((input: string | URL) => {
    const url = String(input);
    if (url.startsWith("/api/feed/seen")) {
      return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
    }
    if (url === "/api/posts/media" || url.startsWith("/api/posts/media?")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              { postId: "p1", mediaUrl: "https://sb.local/p1?token=abc" },
              { postId: "p2", mediaUrl: "https://sb.local/p2?token=abc" },
            ],
            expiresAt: "2026-08-01T00:00:00.000Z",
          },
        }),
      });
    }
    if (url.includes("/playback?posterOnly=1")) {
      const id = url.match(/\/posts\/([^/]+)\/playback/)?.[1] ?? "unknown";
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: { posterUrl: `https://sb.local/posters/${id}.jpg?token=abc`, expiresAt: "2026-08-01T00:00:00.000Z" },
        }),
      });
    }
    if (url.startsWith("/api/feed")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: EXPLORE_POSTS, meta: { nextCursor: null, hasMore: false } }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
  });
}

describe("ExploreFeed — cross-surface bookmark sync (ENG-961)", () => {
  beforeEach(() => {
    resetBookmarkListeners();
    fromMock.mockReset();
    fromMock.mockImplementation((table: string) => {
      if (table === "horse") return exploreChainable({ data: EXPLORE_HORSES, error: null });
      // No bookmark rows for the viewer → every post starts unbookmarked.
      if (table === "bookmark") return exploreChainable({ data: [], error: null });
      return exploreChainable({ data: [], error: null });
    });
    global.fetch = exploreFetchImpl() as unknown as typeof fetch;
  });

  it("Explore flips its icon when the post is saved elsewhere", async () => {
    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    await screen.findByText("Trackwork this morning.");

    const card = screen.getByText("Trackwork this morning.").closest("article.post-web") as HTMLElement;
    const bookmarkButton = card.querySelector(".action-web") as HTMLElement;
    expect(bookmarkButton).toBeTruthy();
    expect(bookmarkButton.className).not.toContain("bookmarked");
    expect(bookmarkButton.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      emitBookmarkChange("p1", true);
    });

    expect(bookmarkButton.className).toContain("bookmarked");
    expect(bookmarkButton.getAttribute("aria-pressed")).toBe("true");
  });
});
