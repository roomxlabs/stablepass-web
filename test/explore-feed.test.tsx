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
function chainable(result: { data: unknown; error: unknown }) {
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

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    expect(await screen.findByText("Mahogany")).toBeInTheDocument();
    expect(screen.getByText("Winx")).toBeInTheDocument();
  });

  // The `feed` edge fn records an impression for every row it serves, so the
  // client POST that used to mirror it was a redundant round-trip per page AND
  // failed RLS on every insert in production. Deleted with /api/feed/seen.
  it("does not post client-side impressions — the feed fn already records them", async () => {
    const fetchMock = fetchImpl(200);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/feed/seen"))).toBe(false);
  });

  it("shows the free-trial-ended wall (no posts) when the feed is gated (402) and the member never subscribed", async () => {
    global.fetch = fetchImpl(402) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    expect(await screen.findByText(/your free trial has ended/i)).toBeInTheDocument();
    expect(screen.queryByText("Mahogany")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get full access" })).toHaveAttribute("href", "/checkout");
  });

  it("shows the access-paused wall (no posts) when the feed is gated (402) and the member has subscribed before", async () => {
    global.fetch = fetchImpl(402) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={true} />);

    expect(await screen.findByText(/your access has paused/i)).toBeInTheDocument();
    expect(screen.queryByText("Mahogany")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy 30 days" })).toHaveAttribute("href", "/checkout");
  });

  it("clicking a reaction button upserts the viewer's own reaction row", async () => {
    global.fetch = fetchImpl(200) as unknown as typeof fetch;
    const user = userEvent.setup();

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
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

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(screen.queryByRole("button", { name: "Following" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Explore" })).toBeInTheDocument();
  });

  describe("aspect ratio (ENG-612)", () => {
    const ratioOf = (el: HTMLElement): number => {
      const [w, h = "1"] = el.style.aspectRatio.split("/").map((part) => part.trim());
      return Number(w) / Number(h);
    };

    function fetchWithAspect(aspectRatio: number | null) {
      return vi.fn((input: string | URL) => {
        const url = String(input);
        if (url === "/api/posts/media" || url.startsWith("/api/posts/media?")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ data: { items: [], expiresAt: "2026-08-01T00:00:00.000Z" } }),
          });
        }
        if (url.startsWith("/api/feed")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ ...POSTS[0], aspect_ratio: aspectRatio }],
              meta: { nextCursor: null, hasMore: false },
            }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
      });
    }

    it("a 16:9 aspect_ratio (1.7778) renders the wide box unclamped", async () => {
      global.fetch = fetchWithAspect(1.7778) as unknown as typeof fetch;

      const { container } = render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
      await screen.findByText("Mahogany");

      const box = container.querySelector<HTMLElement>(".post-media-web");
      expect(box).toBeTruthy();
      expect(ratioOf(box!)).toBeCloseTo(1.7778, 4);
      expect(box!.className).toBe("post-media-web");
    });

    it("a 9:16 reel aspect_ratio (0.5625) clamps to the tall bucket (ASPECT_MIN 0.8)", async () => {
      global.fetch = fetchWithAspect(0.5625) as unknown as typeof fetch;

      const { container } = render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
      await screen.findByText("Mahogany");

      const box = container.querySelector<HTMLElement>(".post-media-web");
      expect(box).toBeTruthy();
      expect(ratioOf(box!)).toBeCloseTo(0.8, 4);
      expect(box!.className).toBe("post-media-web tall");
    });

    it("a null aspect_ratio falls back to ASPECT_DEFAULT (1.6)", async () => {
      global.fetch = fetchWithAspect(null) as unknown as typeof fetch;

      const { container } = render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
      await screen.findByText("Mahogany");

      const box = container.querySelector<HTMLElement>(".post-media-web");
      expect(box).toBeTruthy();
      expect(ratioOf(box!)).toBeCloseTo(1.6, 4);
      expect(box!.className).toBe("post-media-web");
    });
  });
});

// ===========================================================================
// ENG-613 (W2) — the mapper feeds the parity card, and the Follow pill reads
// follow state the screen ALREADY holds.
// ===========================================================================
describe("ExploreFeed — ENG-613 view model + Follow pill", () => {
  const TRAINER = { id: "t1", name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill" };

  /**
   * `undefined` vanishes from a JSON response, so a mapper bug that drops a
   * field looks exactly like a field the payload never had. These fixtures pin
   * the whole key set instead of probing one field at a time.
   */
  function feedWith(rows: unknown[]) {
    return vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === "/api/posts/media" || url.startsWith("/api/posts/media?")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { items: [], expiresAt: "2026-08-01T00:00:00.000Z" } }),
        });
      }
      if (url.includes("/playback?posterOnly=1")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { posterUrl: "https://sb.local/poster?token=abc", expiresAt: "2026-08-01T00:00:00.000Z" } }),
        });
      }
      if (url.startsWith("/api/feed")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: rows, meta: { nextCursor: null, hasMore: false } }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });
  }

  const followInsert = vi.fn(() => Promise.resolve({ error: null }));

  // This describe is a top-level SIBLING of describe("ExploreFeed"), so that
  // block's `beforeEach` does NOT run here. Without its own reset, both the mock
  // implementation and the call HISTORY leak in from the previous describe, and
  // `fromMock.mock.calls.findIndex(c => c[0] === "horse")` below can resolve to
  // an earlier test's call. That is a flaky-test generator, not a style nit.
  beforeEach(() => {
    fromMock.mockReset();
    followInsert.mockReset();
    followInsert.mockImplementation(() => Promise.resolve({ error: null }));
  });

  function mockTables(opts: { follows?: unknown[]; followsError?: { message: string } } = {}) {
    followInsert.mockClear();
    fromMock.mockImplementation((table: string) => {
      if (table === "horse") return chainable({ data: [{ id: "h1", display_name: "Mahogany", trainer: TRAINER }], error: null });
      if (table === "follow") {
        const built = chainable({ data: opts.follows ?? [], error: opts.followsError ?? null });
        (built as unknown as { insert: typeof followInsert }).insert = followInsert;
        return built;
      }
      return chainable({ data: [], error: null });
    });
  }

  // `sb` is untyped, so `tsc` can NEVER catch a too-narrow `.select()`: dropping
  // a column here fails silently at runtime, blanking the panel footer or the
  // pill. Pin the projection string itself.
  it("selects the trainer columns the pill and the panel footer need", async () => {
    mockTables();
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

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
    expect(projection).toContain("trainer:trainer_id(id, name, stable_name, location)");
    // And nothing extra: a widened projection is how owner-adjacent columns
    // would arrive on the card (guardrail 2).
    expect(projection).toBe("id, display_name, trainer:trainer_id(id, name, stable_name, location)");
  });

  it("puts post.title on the view model and renders the STABLE UPDATE card for a text post", async () => {
    mockTables();
    global.fetch = feedWith([
      { id: "p1", horse_id: "h1", type: "text", title: "Where the team is up to", body: "Quiet week here.", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" },
    ]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    // 18 Aug: neither the pill nor the title renders — the panel is the card's face.
    expect(await screen.findByText("Quiet week here.")).toBeInTheDocument();
    expect(document.querySelector(".post-title")).toBeNull();
    expect(document.querySelector(".post-badge")).toBeNull();
    // The footer proves stable_name AND location survived the mapper.
    expect(document.querySelector(".post-panel-foot")!.textContent).toContain("Waller Racing · Rosehill");
  });

  // ROUND 6 / ENG-761 item 1 — `post.label` (ENG-738's 13 presets, or null)
  // read at the DATA LAYER: the row carries it, the mapper puts it on the view
  // model, and the card draws it as the `.post-badge` pill.
  it("puts post.label on the view model and renders it as the pill", async () => {
    mockTables();
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, label: "Race Replay", body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    const badge = document.querySelector(".post-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("Race Replay");
  });

  it("renders no pill when the row's label is null", async () => {
    mockTables();
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, label: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(document.querySelector(".post-badge")).toBeNull();
  });

  it("offers the Follow pill when the viewer follows nobody", async () => {
    mockTables({ follows: [] });
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(await screen.findByRole("button", { name: "Follow Chris Waller" })).toBeInTheDocument();
  });

  it("offers no pill for a trainer the viewer already follows", async () => {
    // The real payload carries the RAW `trainer_id` alongside the embed, and
    // the followed-set is built from the raw column so an RLS-hidden embed
    // cannot silently drop a trainer out of it.
    mockTables({ follows: [{ trainer_id: "t1", trainer: { id: "t1", name: "Chris Waller" } }] });
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    // `waitFor` around a NEGATIVE would resolve on the very first tick, before
    // the follow read has landed — it would assert nothing about the settled
    // state. Anchor on the "Trainers you follow" aside instead: it is rendered
    // from the SAME read, so its presence proves the read resolved. Only then is
    // the pill's absence meaningful.
    expect(await screen.findByText("Trainers you follow")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
  });

  // The gate, not the pill, is the guardrail here: a 402 renders the wall and no
  // cards at all, so an "absent pill" assertion on a gated screen would pass
  // vacuously. Assert the WALL is what is on screen.
  it("renders the reactivate wall, not cards, when the feed returns 402", async () => {
    mockTables();
    global.fetch = fetchImpl(402) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    // POSITIVE anchor first. Without it every assertion below is all-negative
    // and would pass on a blank screen — the exact vacuous-on-402 trap this
    // repo has been bitten by. The wall being present is what proves the 402
    // path actually ran.
    expect(await screen.findByText("Your free trial has ended")).toBeInTheDocument();

    expect(document.querySelector("article.post-web")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
    expect(document.querySelector(".post-panel")).toBeNull();
  });

  // The pill's WRITE had no coverage at all: swapping the table or the payload
  // left the whole suite green. It is the only new mutation in this ticket.
  it("writes the follow to the `follow` table with the viewer's own id, and clears the pill", async () => {
    mockTables({ follows: [] });
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    const pill = await screen.findByRole("button", { name: "Follow Chris Waller" });

    await userEvent.click(pill);

    // `user_id` must be the VIEWER, never the trainer — RLS `follow_rw_self`
    // rejects anything else, and a wrong id here is invisible to `tsc`.
    expect(followInsert).toHaveBeenCalledWith({ user_id: VIEWER_ID, trainer_id: "t1" });

    // Optimistic: the pill goes immediately, on every card by that trainer.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
    });
  });

  it("restores the pill when the follow write fails", async () => {
    mockTables({ follows: [] });
    followInsert.mockImplementationOnce(() => Promise.resolve({ error: { message: "denied" } }) as never);
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Follow Chris Waller" }));

    expect(await screen.findByRole("button", { name: "Follow Chris Waller" })).toBeInTheDocument();
  });

  // A FAILED follow read must leave the state unknown, NOT "follows nobody" —
  // otherwise every card offers Follow, including trainers already followed.
  it("offers no pill at all when the follow read errors", async () => {
    mockTables({ follows: [], followsError: { message: "rls" } });
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    // Positive anchor: the card IS on screen, so the absence below is real.
    await screen.findByText("Mahogany");

    await waitFor(() => {
      expect(document.querySelector("article.post-web")).not.toBeNull();
    });
    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
  });

  // The `!== null` guard ("not known yet" is NOT "follows nobody") was pinned by
  // nothing: deleting it kept the whole suite green while every card flashed a
  // Follow pill — including for trainers already followed. This holds the follow
  // read open, asserts silence, then releases it.
  it("shows no pill until the follow read has actually resolved", async () => {
    let releaseFollows: (rows: unknown[]) => void = () => {};
    const followGate = new Promise<unknown[]>((resolve) => {
      releaseFollows = resolve;
    });

    fromMock.mockImplementation((table: string) => {
      if (table === "horse") return chainable({ data: [{ id: "h1", display_name: "Mahogany", trainer: TRAINER }], error: null });
      if (table === "follow") {
        const obj: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "not", "order"]) obj[m] = vi.fn(() => obj);
        obj.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
          followGate.then((rows) => ({ data: rows, error: null })).then(onF, onR);
        return obj;
      }
      return chainable({ data: [], error: null });
    });

    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    // The CARD is on screen while the follow answer is still outstanding — so
    // this absence is about the unresolved read, not about an empty page.
    await screen.findByText("Mahogany");
    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();

    releaseFollows([]);

    // Once the read says "follows nobody", the pill appears.
    expect(await screen.findByRole("button", { name: "Follow Chris Waller" })).toBeInTheDocument();
  });
});

// ===========================================================================
// ENG-799 — post-media mint via BFF (no client createSignedUrls)
// ===========================================================================
describe("ExploreFeed — ENG-799 post-media mint", () => {
  beforeEach(() => {
    fromMock.mockReset();
    fromMock.mockImplementation((table: string) => {
      if (table === "horse") return chainable({ data: HORSES, error: null });
      return chainable({ data: [], error: null });
    });
  });

  it("makes exactly one POST /api/posts/media for a photo page and zero storage signs", async () => {
    const photoPosts = [
      { ...POSTS[0], media_url: "media/p1.jpg", poster_url: null },
      { ...POSTS[1], media_url: "media/p2.jpg", poster_url: null },
    ];
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/posts/media") {
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
      if (url.startsWith("/api/feed")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: photoPosts, meta: { nextCursor: null, hasMore: false } }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    const mediaCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/posts/media");
    expect(mediaCalls).toHaveLength(1);
    expect(mediaCalls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(mediaCalls[0][1]?.body))).toEqual({ postIds: ["p1", "p2"] });

    // No supabase.storage usage on the browser client mock.
    expect(fromMock.mock.calls.every((c) => c[0] !== "post-media")).toBe(true);
  });

  it("omitted mint id → null poster (placeholder), not an error", async () => {
    const photoPosts = [{ ...POSTS[0], media_url: "media/draft.jpg", poster_url: null }];
    global.fetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === "/api/posts/media") {
        return Promise.resolve({
          ok: true,
          status: 200,
          // Server omits the draft id from items.
          json: async () => ({ data: { items: [], expiresAt: "2026-08-01T00:00:00.000Z" } }),
        });
      }
      if (url.startsWith("/api/feed")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: photoPosts, meta: { nextCursor: null, hasMore: false } }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    }) as unknown as typeof fetch;

    const { container } = render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.querySelector(".post-media-web img")).toBeNull();
    expect(container.querySelector(".post-media-web")).not.toBeNull();
  });

  it("renders the reactivate wall when the mint returns 402", async () => {
    const photoPosts = [{ ...POSTS[0], media_url: "media/p1.jpg", poster_url: null }];
    global.fetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === "/api/posts/media") {
        return Promise.resolve({
          ok: false,
          status: 402,
          json: async () => ({ error: { code: "subscription_required" } }),
        });
      }
      if (url.startsWith("/api/feed")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: photoPosts, meta: { nextCursor: null, hasMore: false } }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    }) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={true} />);
    expect(await screen.findByText(/your access has paused/i)).toBeInTheDocument();
    expect(screen.queryByText("Mahogany")).not.toBeInTheDocument();
  });
});

// ===========================================================================
// ENG-762 / ENG-815 — the multi-photo carousel, rendered through ExploreFeed's
// REAL mapper. Not a hand-built FeedPost/PostCard render: bypassing the mapper
// is exactly the bug class ENG-772 exists to catch. `slideCount` now rides in
// on the SAME /api/posts/media batch the ENG-799 mint tests above already
// stub, and slides 1+ mint one at a time by `{ postId, slideIndex }` through
// that same route (ENG-809 decision 2) — there is no more client-side
// `post_media` read to mock.
// ===========================================================================
describe("ExploreFeed — ENG-762 multi-photo carousel", () => {
  const CAROUSEL_POSTS = [
    { ...POSTS[0], media_url: "media/p1.jpg", poster_url: null },
    { ...POSTS[1], media_url: "media/p2.jpg", poster_url: null },
  ];

  beforeEach(() => {
    fromMock.mockReset();
    fromMock.mockImplementation((table: string) => {
      if (table === "horse") return chainable({ data: HORSES, error: null });
      return chainable({ data: [], error: null });
    });
  });

  function fetchWithCarousel(slideCount: number) {
    return vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/posts/media") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if ("postId" in body) {
          // Slide N minted by index (usePostSlides), never a batch of ids.
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                postId: body.postId,
                slideIndex: body.slideIndex,
                mediaUrl: `https://sb.local/${body.postId}-${body.slideIndex}.jpg`,
                expiresAt: "2026-08-01T00:00:00.000Z",
              },
            }),
          });
        }
        // `slideCount` rides in on the SAME batch as slide 0's url, which is
        // what lets the dots be right before any further slide is minted.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [
                { postId: "p1", mediaUrl: "https://sb.local/p1-0.jpg", slideCount },
                { postId: "p2", mediaUrl: "https://sb.local/p2.jpg" },
              ],
              expiresAt: "2026-08-01T00:00:00.000Z",
            },
          }),
        });
      }
      if (url.startsWith("/api/feed")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: CAROUSEL_POSTS, meta: { nextCursor: null, hasMore: false } }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });
  }

  it("renders the multi-photo carousel (ENG-762 / ENG-815)", async () => {
    const fetchMock = fetchWithCarousel(3);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(screen.getAllByTestId("photo-slide")).toHaveLength(3);
    expect(screen.getByTestId("photo-dots").querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/3");

    // WHICH IDS the screen actually asked for, on the SAME batch that carries
    // slideCount — the ENG-772 silent-drop class, moved onto the mint path. A
    // mapper that asked the batch for the wrong ids would still pass every
    // assertion above, since the fixture answers unconditionally.
    const mediaCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/posts/media");
    const batch = mediaCalls
      .map((c) => JSON.parse(String(c[1]?.body)))
      .find((b) => "postIds" in b);
    expect(batch).toEqual({ postIds: ["p1", "p2"] });
  });

  it("renders no carousel for a single-photo post (ENG-762 / ENG-815)", async () => {
    global.fetch = fetchWithCarousel(1) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(screen.queryByTestId("photo-dots")).toBeNull();
    expect(screen.queryByTestId("photo-track")).toBeNull();
  });
});
