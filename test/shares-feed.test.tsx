import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SharesFeed } from "@/app/(member)/shares/shares-feed";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

const POSTS = [
  {
    id: "sale-1",
    horse_id: "h-sale",
    type: "photo",
    body: "Shares still available.",
    media_url: null,
    watermarked: false,
    like_count: 3,
    published_at: "2026-08-20T00:00:00.000Z",
  },
];

const HORSES = [
  {
    id: "h-sale",
    display_name: "For Sale Filly",
    trainer: {
      id: "t1",
      name: "Chris Waller",
      stable_name: "Waller Racing",
      location: "Warwick Farm",
      website_url: "https://wallerracing.example",
    },
  },
];

function chainable(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ from: fromMock }),
}));

function fetchImpl() {
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
            items: [{ postId: "sale-1", mediaUrl: "https://sb.local/sale-1?token=abc" }],
            expiresAt: "2026-08-01T00:00:00.000Z",
          },
        }),
      });
    }
    if (url.startsWith("/api/feed/shares")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: POSTS, meta: { nextCursor: null, hasMore: false } }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
}

describe("SharesFeed (ENG-831)", () => {
  beforeEach(() => {
    fromMock.mockReset();
    vi.stubGlobal("fetch", fetchImpl());

    fromMock.mockImplementation((table: string) => {
      if (table === "horse") {
        return chainable({ data: HORSES, error: null });
      }
      if (table === "reaction" || table === "bookmark") {
        return chainable({ data: [], error: null });
      }
      if (table === "race") {
        return chainable({ data: [], error: null });
      }
      if (table === "follow") {
        return chainable({ data: [], error: null });
      }
      return chainable({ data: [], error: null });
    });
  });

  it("loads the Shares BFF (shares=true), not Explore", async () => {
    render(<SharesFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => {
      expect(screen.getByText("For Sale Filly")).toBeInTheDocument();
    });

    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.startsWith("/api/feed/shares"))).toBe(true);
    expect(urls.some((u) => u === "/api/feed" || u.startsWith("/api/feed?"))).toBe(false);
  });

  it("renders Shares cards with Contact CTA and without Follow", async () => {
    render(<SharesFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Contact trainer" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Shares" })).toBeInTheDocument();
  });

  it("selects trainer website_url for the Contact CTA", async () => {
    render(<SharesFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => {
      expect(screen.getByText("For Sale Filly")).toBeInTheDocument();
    });

    const horseCalls = fromMock.mock.calls.filter((c) => c[0] === "horse");
    expect(horseCalls.length).toBeGreaterThan(0);
    // First horse read is the feed enrichment (with website_url).
    const enrichment = fromMock.mock.results.find((_, i) => fromMock.mock.calls[i][0] === "horse");
    const chain = enrichment?.value as { select: ReturnType<typeof vi.fn> };
    expect(chain.select).toHaveBeenCalledWith(
      "id, display_name, trainer:trainer_id(id, name, stable_name, location, website_url)",
    );
  });
});
