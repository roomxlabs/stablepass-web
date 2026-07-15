import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExploreFeed } from "@/app/(member)/explore/explore-feed";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

const POSTS = [
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

const HORSES = [
  { id: "h1", display_name: "Mahogany", trainer: { name: "Chris Waller" } },
  { id: "h2", display_name: "Winx", trainer: { name: "Chris Waller" } },
];

// A chainable Supabase-style query builder mock: every filter method returns
// itself, and it resolves via `.then` (like the real postgrest-js builders).
function chainable(result: { data: unknown; error: null }) {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.delete = vi.fn(() => obj);
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

const { fromMock, upsertMock, insertMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  upsertMock: vi.fn(() => Promise.resolve({ error: null })),
  insertMock: vi.fn(() => Promise.resolve({ error: null })),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ from: fromMock }),
}));

function fetchImpl(feedStatus: 200 | 402) {
  return vi.fn((input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/feed/seen")) {
      return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
    }
    if (url.startsWith("/api/feed")) {
      if (feedStatus === 402) {
        return Promise.resolve({ ok: false, status: 402, json: async () => ({ error: { code: "subscription_required" } }) });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: POSTS, meta: { nextCursor: null, hasMore: false } }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
  });
}

describe("ExploreFeed", () => {
  beforeEach(() => {
    fromMock.mockReset();
    upsertMock.mockClear();
    insertMock.mockClear();

    fromMock.mockImplementation((table: string) => {
      const built = chainable({ data: [], error: null });
      if (table === "horse") return chainable({ data: HORSES, error: null });
      if (table === "reaction") {
        // Reused for the read-side enrichment (select().in()) AND the write-side
        // (upsert/delete) reaction test below.
        (built as unknown as { upsert: typeof upsertMock }).upsert = upsertMock;
        (built as unknown as { insert: typeof insertMock }).insert = insertMock;
        return built;
      }
      if (table === "bookmark") {
        (built as unknown as { insert: typeof insertMock }).insert = insertMock;
        return built;
      }
      return built;
    });
  });

  it("renders a PostCard per enriched post row (horse names from the enrichment lookup)", async () => {
    global.fetch = fetchImpl(200) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} />);

    expect(await screen.findByText("Mahogany")).toBeInTheDocument();
    expect(screen.getByText("Winx")).toBeInTheDocument();
  });

  it("records impressions for the fetched page via POST /api/feed/seen", async () => {
    const fetchMock = fetchImpl(200);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} />);
    await screen.findByText("Mahogany");

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/feed/seen");
      expect(call).toBeTruthy();
      const init = call?.[1];
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ postIds: ["p1", "p2"] });
    });
  });

  it("shows the reactivate prompt (no posts) when the feed is gated (402)", async () => {
    global.fetch = fetchImpl(402) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} />);

    expect(await screen.findByText(/trial has ended/i)).toBeInTheDocument();
    expect(screen.queryByText("Mahogany")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reactivate" })).toHaveAttribute("href", "/checkout");
  });

  it("clicking a reaction button upserts the viewer's own reaction row", async () => {
    global.fetch = fetchImpl(200) as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<ExploreFeed viewerId={VIEWER_ID} />);
    await screen.findByText("Mahogany");

    const fireButtons = screen.getAllByRole("button", { name: "Fire" });
    await user.click(fireButtons[0]);

    await waitFor(() =>
      expect(upsertMock).toHaveBeenCalledWith(
        { user_id: VIEWER_ID, post_id: "p1", emoji: "fire" },
        { onConflict: "user_id,post_id" },
      ),
    );
  });

  it("renders no Following tab (Explore is a single view since W13)", async () => {
    global.fetch = fetchImpl(200) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} />);
    await screen.findByText("Mahogany");

    expect(screen.queryByRole("button", { name: "Following" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Explore" })).toBeInTheDocument();
  });
});
