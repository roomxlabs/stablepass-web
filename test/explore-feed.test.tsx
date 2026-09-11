import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExploreFeed } from "@/app/(member)/explore/explore-feed";
import { WALL_COPY } from "@/components/access-wall";
// The real bucket constant, not a retyped string: ENG-1063's guard asserts
// `storage.from` was called with it (and, in the lapsed case, not at all), and
// a stale literal here would quietly weaken both.
import { TRAINER_PHOTO_BUCKET } from "@/lib/storage/photos";

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

const { fromMock, upsertMock, insertMock, storageFromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  upsertMock: vi.fn(() => Promise.resolve({ error: null })),
  insertMock: vi.fn(() => Promise.resolve({ error: null })),
  // A `vi.fn()`, not a bare object literal — ENG-1057 follow-up's guardrail
  // test needs to assert `storage.from` was NEVER reached for a trainer whose
  // `follow` embed came back null (RLS-hidden), so this has to be spyable.
  storageFromMock: vi.fn((_bucket: string) => ({
    createSignedUrls: (paths: string[]) =>
      Promise.resolve({ data: paths.map((path) => ({ path, signedUrl: `https://sb.local/signed/${path}` })) }),
  })),
}));

// `.storage` is only exercised when a fixture supplies a real `photo_url`
// path — `signPhotoMap` returns early on an empty path list, so every
// existing fixture in this file (no `photo_url` at all) never reaches it.
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    from: fromMock,
    storage: { from: storageFromMock },
  }),
}));

function fetchImpl(feedStatus: 200 | 402) {
  return vi.fn((input: string | URL, _init?: RequestInit) => {
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

  it("records impressions for the fetched page via POST /api/feed/seen", async () => {
    const fetchMock = fetchImpl(200);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]) === "/api/feed/seen");
      expect(call).toBeTruthy();
      const init = call?.[1];
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ postIds: ["p1", "p2"] });
    });
  });

  it("shows the no-pass-yet wall (no posts) when the feed is gated (402) and the member never subscribed", async () => {
    global.fetch = fetchImpl(402) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    // ENG-1008: the never-subscribed wall no longer claims a trial ended — that
    // member never had one. Read the title from WALL_COPY rather than retyping
    // it; this string had been retyped in five test files and went stale in all
    // of them the moment the copy was fixed.
    expect(await screen.findByText(WALL_COPY.neverSubscribed.title)).toBeInTheDocument();
    expect(screen.queryByText("Mahogany")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get full access" })).toHaveAttribute("href", "/checkout");
  });

  it("shows the access-paused wall (no posts) when the feed is gated (402) and the member has subscribed before", async () => {
    global.fetch = fetchImpl(402) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={true} />);

    expect(await screen.findByText(/your access has paused/i)).toBeInTheDocument();
    expect(screen.queryByText("Mahogany")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Restart my subscription" })).toHaveAttribute("href", "/checkout");
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
        if (url.startsWith("/api/feed/seen")) {
          return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
        }
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
      if (url.startsWith("/api/feed/seen")) return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
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
    storageFromMock.mockClear();
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
    expect(projection).toContain("trainer:trainer_id(id, name, stable_name, location, photo_url)");
    // And nothing extra: a widened projection is how owner-adjacent columns
    // would arrive on the card (guardrail 2).
    expect(projection).toBe(
      "id, display_name, photo_url, trainer:trainer_id(id, name, stable_name, location, photo_url)",
    );
  });

  // ENG-1057 follow-up — same reasoning as the horse projection above, for the
  // "Trainers you follow" aside's own read. Deleting `photo_url` here leaves
  // the whole suite green (verified by hand before adding this pin): every
  // other assertion on this aside reads names/counts off a hand-built fixture,
  // never the projection string sent to the database.
  it("pins the follow read's exact projection, including the trainer's photo_url", async () => {
    mockTables();
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    const followCallIndex = fromMock.mock.calls.findIndex((c) => c[0] === "follow");
    expect(followCallIndex).toBeGreaterThanOrEqual(0);
    const chain = fromMock.mock.results[followCallIndex].value as { select: ReturnType<typeof vi.fn> };
    const projection = chain.select.mock.calls[0][0] as string;

    expect(projection).toBe("trainer_id, trainer:trainer_id(id,name,photo_url)");
  });

  // ENG-1057 follow-up — the aside's own behavioural gap: nothing in this file
  // asserted that a followed trainer's photo actually reaches the DOM as a
  // signed <img>.
  it("ENG-1057: 'Trainers you follow' renders a signed <img class=trainer-avatar-mini-photo>", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "horse") return chainable({ data: [{ id: "h1", display_name: "Mahogany", trainer: TRAINER }], error: null });
      if (table === "follow") {
        return chainable({
          data: [{ trainer_id: "t1", trainer: { id: "t1", name: "Chris Waller", photo_url: "trainers/waller.jpg" } }],
          error: null,
        });
      }
      return chainable({ data: [], error: null });
    });
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Trainers you follow");

    // Scoped to the aside row's own class — the feed's post avatars use a
    // different one, so this is unambiguous even though both are <img alt="">.
    const asideImg = await waitFor(() => {
      const el = document.querySelector(".aside-trainer-row .trainer-avatar-mini-photo");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(asideImg).toHaveAttribute("src", "https://sb.local/signed/trainers/waller.jpg");
  });

  // ENG-1057 follow-up (guardrail hardening) — pins a property that currently
  // holds only by RLS accident: `trainer_select_sub` hides a lapsed/unentitled
  // viewer's trainer rows, so the `follow` embed nulls out even though
  // `trainer_id` itself is still readable. That must never reach Storage.
  it("GUARDRAIL: a NULL trainer embed on every follow row (RLS-hidden) never touches Storage", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "horse") return chainable({ data: [{ id: "h1", display_name: "Mahogany", trainer: TRAINER }], error: null });
      if (table === "follow") {
        return chainable({
          data: [
            { trainer_id: "t1", trainer: null },
            { trainer_id: "t2", trainer: null },
          ],
          error: null,
        });
      }
      return chainable({ data: [], error: null });
    });
    global.fetch = feedWith([{ id: "p1", horse_id: "h1", type: "photo", title: null, body: "x", media_url: null, poster_url: null, aspect_ratio: null, watermarked: false, like_count: 1, published_at: "2026-07-10T00:00:00.000Z" }]) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    // Positive anchor that the follow read actually ran and resolved, so the
    // absence below is real rather than a race against an unsettled effect.
    await waitFor(() => expect(fromMock.mock.calls.some((c) => c[0] === "follow")).toBe(true));
    // A NULL embed on every row means the trainerMap stays empty, so the
    // screen never even reaches the horse-count round trip, let alone signing.
    expect(screen.queryByText("Trainers you follow")).not.toBeInTheDocument();
    expect(storageFromMock).not.toHaveBeenCalled();
  });

  // ENG-958 — through the REAL mapper, not a hand-built FeedPost: the
  // documented failure mode is the route returning the column correctly and
  // the SCREEN discarding it one layer later, which a projection assertion
  // alone cannot catch.
  it("signs the horse+trainer photo paths and renders the SIGNED url on the card, not the raw path", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "horse") {
        return chainable({
          data: [
            {
              id: "h1",
              display_name: "Mahogany",
              photo_url: "horses/mahogany.jpg",
              trainer: { id: "t1", name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill", photo_url: "trainers/waller.jpg" },
            },
          ],
          error: null,
        });
      }
      return chainable({ data: [], error: null });
    });
    global.fetch = fetchImpl(200) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);

    const avatar = await screen.findByTestId("post-avatar-photo");
    expect(avatar).toHaveAttribute("src", "https://sb.local/signed/horses/mahogany.jpg");
    expect(avatar).not.toHaveAttribute("src", "horses/mahogany.jpg");
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
    // ENG-1008: read the anchor from WALL_COPY rather than retyping it. This
    // string was retyped across five test files and went stale in every one of
    // them; the anchor only has to prove the wall RENDERED (i.e. the 402 path
    // actually ran), and the wall's own copy is pinned in test/access-wall.test.tsx.
    expect(await screen.findByText(WALL_COPY.neverSubscribed.title)).toBeInTheDocument();

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
      if (url.startsWith("/api/feed/seen")) {
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
      }
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
      if (url.startsWith("/api/feed/seen")) {
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
      }
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
      if (url.startsWith("/api/feed/seen")) {
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
      }
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
      if (url.startsWith("/api/feed/seen")) {
        return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
      }
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

// ---------------------------------------------------------------------------
// ENG-1063 (MEDIUM-1) — GUARDRAIL 3, Explore's "Trainers you follow" aside.
//
// READ THIS BEFORE ADDING A "lapsed viewer signs nothing" TEST HERE. The
// ticket asked for a guard pinning the OBSERVABLE property (zero
// `/storage/v1/object/sign` calls for a lapsed viewer) rather than the
// mechanism that currently delivers it. That guard CANNOT be written against
// today's code, and the first attempt at it was removed for claiming to be one.
// The reason is worth writing down, because it will be re-attempted:
//
//   Explore has no front-end gate. `horses-grid.tsx` / `trainers-grid.tsx`
//   read `subscription` themselves and sign only after `hasAccess`, which
//   `test/browse-grid-paging.test.tsx` pins. Explore cannot: `gated` is only
//   known once the `/api/feed` 402 resolves, and the aside's effect fires in
//   parallel on mount with `[]` deps.
//
//   So a lapsed fixture has to choose. With the trainer embed NULL (what
//   `trainer_select_sub` really returns for a lapsed viewer) the zero-sign
//   result is over-determined three times over — `trainerMap` is empty, the
//   `trainerIds.length === 0` early return fires, and `signPhotoMap` itself
//   returns at `lib/storage/photos.ts` before touching `storage.from`. VERIFIED:
//   deleting the early return from explore-feed.tsx leaves all of this file
//   green. A test on that fixture pins nothing about Explore, whatever its
//   title says, and duplicates the existing guard above at "a NULL trainer
//   embed on every follow row (RLS-hidden) never touches Storage".
//
//   With the embed VISIBLE, Explore signs — for a lapsed viewer, today. That
//   is the real gap, and it is pinned as a LIMITATION at the bottom of this
//   block rather than papered over.
//
// What is left that IS worth pinning is narrow and honestly titled: the walled
// render path reaches the same no-signing outcome. The observable-property
// guard arrives with the restructure, not before.
describe("ExploreFeed — ENG-1063 GUARDRAIL 3: the aside's signing, on the walled path", () => {
  const FOLLOWED_TRAINER = { id: "t1", name: "Chris Waller", photo_url: "trainers/waller.jpg" };
  const HORSE_ROW = { id: "h1", display_name: "Mahogany", trainer: { id: "t1", name: "Chris Waller" } };

  // A top-level SIBLING describe, so no other block's `beforeEach` runs here —
  // same reasoning (and same hazard) the ENG-613 block documents: without its
  // own reset, both the implementation and the call HISTORY leak in from the
  // previous describe, and `expect(storageFromMock).not.toHaveBeenCalled()`
  // would be reading somebody else's calls.
  beforeEach(() => {
    fromMock.mockReset();
    storageFromMock.mockClear();
  });

  /** `follow` answers with `rows`; every other table is empty. */
  function mockFollowRows(rows: unknown[]) {
    fromMock.mockImplementation((table: string) => {
      if (table === "horse") return chainable({ data: [HORSE_ROW], error: null });
      if (table === "follow") return chainable({ data: rows, error: null });
      return chainable({ data: [], error: null });
    });
  }

  /** Every signed URL this file's storage mock hands out starts with this. */
  const SIGNED_PREFIX = "https://sb.local/signed/";

  function renderedSignedUrls(): string[] {
    return Array.from(document.querySelectorAll("img"))
      .map((img) => img.getAttribute("src") ?? "")
      .filter((src) => src.startsWith(SIGNED_PREFIX));
  }

  // THE POSITIVE CONTROL. `not.toHaveBeenCalled()` is only evidence if the spy
  // would have fired, and this pins that the mock really is wired end to end:
  // `supabaseBrowser().storage.from` is reachable, and a signed URL really does
  // reach the DOM. Without it a stub that stopped exposing `.storage` would
  // make every negative in this block pass on nothing at all.
  it("CONTROL — an entitled viewer signs the aside's thumb and renders it", async () => {
    mockFollowRows([{ trainer_id: "t1", trainer: FOLLOWED_TRAINER }]);
    global.fetch = fetchImpl(200) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Trainers you follow");

    await waitFor(() => expect(storageFromMock).toHaveBeenCalledWith(TRAINER_PHOTO_BUCKET));
    await waitFor(() => expect(renderedSignedUrls()).toContain(`${SIGNED_PREFIX}trainers/waller.jpg`));
  });

  // Deliberately NOT titled "a lapsed session signs nothing" — see the block
  // comment. The 402 is what is under test here (the wall renders and the aside
  // still settles to its no-signing terminal state); the NULL embed is what
  // makes the outcome zero, and that half is already pinned above.
  it("a NULL embed still signs nothing when the feed came back 402 and the wall is on screen", async () => {
    mockFollowRows([
      { trainer_id: "t1", trainer: null },
      { trainer_id: "t2", trainer: null },
    ]);
    global.fetch = fetchImpl(402) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed />);

    // Positive anchors before any absence. An all-negative set on a 402 screen
    // passes vacuously — this file and `.rx/gotchas.md` both record being
    // bitten by exactly that.
    //   (1) the lapsed path ran and the wall is what is on screen;
    expect(await screen.findByText(WALL_COPY.paused.title)).toBeInTheDocument();
    expect(screen.getAllByTestId("access-wall").length).toBeGreaterThan(0);
    //   (2) the aside's effect reached its TERMINAL state, not merely its first
    //       await. `setTrainers([])` having landed is what makes the absence a
    //       settled answer rather than a race — the same anchor the sibling
    //       NULL-embed guard above uses.
    await waitFor(() => expect(fromMock.mock.calls.some((c) => c[0] === "follow")).toBe(true));
    expect(screen.queryByText("Trainers you follow")).not.toBeInTheDocument();

    // `sb.storage.from(bucket)` is the only door to `createSignedUrls`, so
    // never reaching it is exactly zero sign calls.
    expect(storageFromMock).not.toHaveBeenCalled();
    // NOTE: no DOM-side assertion here. The walled render paints no <img> at
    // all (measured: `document.querySelectorAll("img").length === 0`), so
    // `expect(renderedSignedUrls()).toEqual([])` would iterate an empty list
    // and assert nothing. The spy above is the assertion that has force.
  });

  // A CHARACTERIZATION test: it pins what the code does today, which is NOT
  // what we want it to do. Keeping it green is not the goal — when Explore is
  // restructured so signing waits for the gate to resolve, this goes red, and
  // the correct edit is to invert it (`not.toHaveBeenCalled()`, no signed
  // <img>) and delete this comment.
  //
  // This is the ticket's real finding, stated as an executable fact so it
  // cannot evaporate the way ENG-1058's review prose would have: relax
  // `trainer_select_sub` for a lapsed teaser and Explore issues sign calls for
  // walled members, with nothing else in the front end to stop it.
  it("LIMITATION (pinned, not endorsed): with the embed visible, a lapsed viewer signs AND renders the photo", async () => {
    mockFollowRows([{ trainer_id: "t1", trainer: FOLLOWED_TRAINER }]);
    global.fetch = fetchImpl(402) as unknown as typeof fetch;

    render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed />);

    expect(await screen.findByText(WALL_COPY.paused.title)).toBeInTheDocument();
    // The effect signs even though the screen is walled — the front end never
    // consults `gated`, which is only known once the /api/feed 402 resolved.
    await waitFor(() => expect(storageFromMock).toHaveBeenCalledWith(TRAINER_PHOTO_BUCKET));
    // And it is not merely a request: the signed URL is painted into the
    // aside, BEHIND the wall. Asserting the render rather than just the call
    // keeps this test honest about how far the gap actually goes.
    await waitFor(() => expect(renderedSignedUrls()).toContain(`${SIGNED_PREFIX}trainers/waller.jpg`));
    expect(screen.getByText("Trainers you follow")).toBeInTheDocument();
    // In production the member would still see no photo: storage RLS
    // `media gated read` is a second, independent BE boundary that returns an
    // empty map for a lapsed viewer, so `signed.get(...)` yields null and the
    // row falls back to initials. That mitigation lives in
    // stablepass-be (`20260704120002_rls_policies.sql`) and is NOT verified by
    // this suite — this harness's storage mock signs unconditionally. Do not
    // read the assertions above as proof the image reaches a real member; read
    // them as proof the front end asks, which is the part we own.
  });
});
