import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
// ENG-613: the trainer sub-select gained `stable_name`/`location` for the STABLE
// UPDATE panel footer. Saved offers no Follow pill, so it needs no trainer `id`.
const HORSES = [
  { id: "h1", display_name: "Nature Strip", trainer: { name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill" } },
  { id: "h2", display_name: "Winx", trainer: { name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill" } },
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

// ENG-762 — the multi-photo carousel read. Mocked at the module boundary
// rather than faked through the PostgREST chain: `readPostPhotos` owns its
// own query + signing round trip and carries its own unit coverage
// (lib/post-media.ts). `photosMock` starts empty (reset in the beforeEach
// below) so every PRE-EXISTING test in this file — none of which touches it
// — renders exactly as it did before ENG-762.
let photosMock = new Map<string, { url: string | null; sort: number }[]>();

vi.mock("@/lib/post-media", () => ({
  readPostPhotos: vi.fn(() => Promise.resolve(photosMock)),
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
  photosMock = new Map();
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

  // ENG-612 — the PLAYING <video> box, not just the poster box.
  //
  // This is the branch that actually matters. Photos never carry an
  // `aspect_ratio` (a Storage asset has no Mux ratio), so a VIDEO is the only
  // media type that ever has a real one — yet the inline player on all five
  // surfaces was covered by nothing. `tsc` catches a wrong field name here, but
  // not a dropped `style`, a reverted spread, or a `mediaBoxProps(null)`.
  describe("the playing <video> box (ENG-612)", () => {
    const PLAYBACK_URL = "https://stream.mux.test/signed.m3u8?token=stub";

    const ratioOf = (el: HTMLElement): number => {
      const [w, h = "1"] = el.style.aspectRatio.split("/").map((part) => part.trim());
      return Number(w) / Number(h);
    };

    beforeEach(() => {
      // A 9:16 reel VIDEO: since 18 Aug the true ratio renders (no 4:5
      // clamp), and it must still hold AFTER the poster is swapped for the
      // player — the same box wraps both.
      bookmarkData = [
        { ...BOOKMARKS[0], post: { ...BOOKMARKS[0].post, type: "video", aspect_ratio: 0.5625 } },
      ];
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          status: 200,
          json: async () => ({ data: { playbackUrl: PLAYBACK_URL } }),
        })),
      );
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("keeps the clamped ratio after play, and the player carries no hardcoded 16/9 or #000", async () => {
      const { container } = render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
      await screen.findByText("Nature Strip");

      // Assert the poster box first, so a failure after play is unambiguous.
      // 18 Aug: a portrait VIDEO is a reel — the true ratio renders, not the 4:5 clamp.
      expect(ratioOf(container.querySelector<HTMLElement>(".post-media-web")!)).toBeCloseTo(0.5625, 4);

      await userEvent.click(screen.getByRole("button", { name: "Play video" }));

      const video = await waitFor(() => {
        const found = container.querySelector<HTMLVideoElement>(".post-media-web video");
        expect(found).toBeTruthy();
        return found!;
      });

      // Guardrail: the src is the minted signed URL, never a raw Mux asset.
      expect(video.getAttribute("src")).toBe(PLAYBACK_URL);

      // The box wrapping the player keeps the SAME reel geometry as the poster.
      const box = video.closest<HTMLElement>(".post-media-web")!;
      expect(ratioOf(box)).toBeCloseTo(0.5625, 4);
      expect(box.className).toBe("post-media-web reel");

      // Acceptance: the hardcoded player styles are gone. Geometry and ground
      // both come from the box now, so the element has neither of its own.
      expect(video.style.aspectRatio).toBe("");
      expect(video.style.background).toBe("");
    });
  });

});

// ===========================================================================
// ENG-613 (W2) — Saved gets the parity card too, but deliberately NO Follow
// pill: it holds no trainer-follow state, and the ticket wires the pill on
// Explore and Following only.
// ===========================================================================
describe("SavedFeed — ENG-613 view model", () => {
  // Sibling of the describe above, so ITS beforeEach does not run here.
  // Clear the call history the projection assertion reads.
  beforeEach(() => {
    fromMock.mockClear();
  });

  // `sb` is untyped, so `tsc` can never catch a too-narrow `.select()`; an
  // omitted column silently blanks the panel footer at runtime.
  it("selects the trainer columns the panel footer needs", async () => {
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    const horseCallIndex = fromMock.mock.calls.findIndex((c) => c[0] === "horse");
    expect(horseCallIndex).toBeGreaterThanOrEqual(0);
    const chain = fromMock.mock.results[horseCallIndex].value as { select: ReturnType<typeof vi.fn> };
    const projection = chain.select.mock.calls[0][0] as string;

    // Assert the WHOLE embed, not a per-column `toContain`. "id" is a substring
    // of `trainer_id(` and of the horse's own `id`, and "name" is a substring of
    // `display_name`, so a per-column loop still passes after the trainer's `id`
    // is dropped — while `trainerId` goes null on every post and the Follow pill
    // silently vanishes feed-wide with a green suite. `sb` is untyped, so this
    // string IS the only guard.
    expect(projection).toContain("trainer:trainer_id(name, stable_name, location)");
    // And nothing extra: a widened projection is how owner-adjacent columns
    // would arrive on the card (guardrail 2).
    expect(projection).toBe("id, display_name, trainer:trainer_id(name, stable_name, location)");
  });

  it("puts post.title on the view model and draws the STABLE UPDATE card", async () => {
    bookmarkData = [
      {
        created_at: "2026-07-12T00:00:00.000Z",
        post: { id: "p1", horse_id: "h1", type: "text", title: "Where the team is up to", body: "Quiet week here.", media_url: null, watermarked: false, like_count: 3, published_at: "2026-07-10T00:00:00.000Z" },
      },
    ];

    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    // 18 Aug: neither the pill nor the title renders — the panel is the card's face.
    expect(await screen.findByText("Quiet week here.")).toBeInTheDocument();
    expect(document.querySelector(".post-title")).toBeNull();
    expect(document.querySelector(".post-badge")).toBeNull();
    expect(document.querySelector(".post-panel-foot")!.textContent).toContain("Waller Racing · Rosehill");
  });

  // Not vacuous: the card above IS rendered on this screen, so the pill's
  // absence is a real assertion about this surface, not about an empty page.
  it("offers no Follow pill on Saved", async () => {
    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    expect(document.querySelector("article.post-web")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
  });
});

// ===========================================================================
// ENG-762 — the multi-photo carousel, rendered through SavedFeed's REAL
// mapper. Not a hand-built FeedPost/PostCard render: bypassing the mapper is
// exactly the bug class ENG-772 exists to catch.
// ===========================================================================
describe("SavedFeed — ENG-762 multi-photo carousel", () => {
  it("renders the multi-photo carousel (ENG-762)", async () => {
    photosMock = new Map([
      [
        "p1",
        [
          { url: "https://signed.test/p1-0.jpg", sort: 0 },
          { url: "https://signed.test/p1-1.jpg", sort: 1 },
          { url: "https://signed.test/p1-2.jpg", sort: 2 },
        ],
      ],
    ]);

    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    expect(screen.getAllByTestId("photo-slide")).toHaveLength(3);
    expect(screen.getByTestId("photo-dots").querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/3");
  });

  it("renders no carousel for a single-photo post (ENG-762)", async () => {
    photosMock = new Map([["p1", [{ url: "https://signed.test/p1-0.jpg", sort: 0 }]]]);

    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    expect(screen.queryByTestId("photo-dots")).toBeNull();
    expect(screen.queryByTestId("photo-track")).toBeNull();
  });
});
