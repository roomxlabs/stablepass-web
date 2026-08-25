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

  // ENG-775. A RENDER assertion, deliberately not a data-layer one: this screen's
  // projection is `post:post_id(*)`, so `label` always arrives from the database —
  // the drop was in the screen's own row→FeedPost mapper. Asserting on the
  // `.select()` string (the ENG-772 shape) would therefore pass with the bug
  // present. This fails unless the mapper actually copies `label` through to the card.
  it("renders the green label pill on a saved card (ENG-775)", async () => {
    // Deliberately NOT "Trackwork": the default fixture's body is "Trackwork.",
    // so that value would be one full stop away from matching the CAPTION, and a
    // reader could not tell the assertion apart from a false positive at a glance.
    // "Jockey Comments" (also an ENG-738 preset) appears nowhere else in the DOM.
    bookmarkData = [{ ...BOOKMARKS[0], post: { ...BOOKMARKS[0].post, label: "Jockey Comments" } }];

    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    expect(document.querySelector(".post-badge")!.textContent).toBe("Jockey Comments");
  });

  // The negative control pins `null` explicitly rather than leaning on the
  // fixture's ABSENT key: the column is nullable, so `null` is the shape the
  // database actually produces for an unlabelled post.
  it("renders no label pill on an unlabelled saved card (ENG-775)", async () => {
    bookmarkData = [{ ...BOOKMARKS[0], post: { ...BOOKMARKS[0].post, label: null } }];

    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    expect(document.querySelector(".post-badge")).toBeNull();
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

    // The panel is the card's face here, so no title renders; and this fixture
    // carries no `label`, so no pill either (the pill itself returned in ENG-761).
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
// ENG-799 — post-media mint via BFF (no client createSignedUrls)
// ===========================================================================
describe("SavedFeed — ENG-799 post-media mint", () => {
  it("makes exactly one POST /api/posts/media for a photo page", async () => {
    bookmarkData = [
      {
        created_at: "2026-07-12T00:00:00.000Z",
        post: {
          id: "p1",
          horse_id: "h1",
          type: "photo",
          body: "Trackwork.",
          media_url: "media/p1.jpg",
          poster_url: null,
          watermarked: false,
          like_count: 3,
          published_at: "2026-07-10T00:00:00.000Z",
        },
      },
    ];
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;

    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    const mediaCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/posts/media");
    expect(mediaCalls).toHaveLength(1);
    expect(JSON.parse(String(mediaCalls[0][1]?.body))).toEqual({ postIds: ["p1"] });
  });

  it("omitted mint id → placeholder, not an error", async () => {
    bookmarkData = [
      {
        created_at: "2026-07-12T00:00:00.000Z",
        post: {
          id: "p1",
          horse_id: "h1",
          type: "photo",
          body: "Trackwork.",
          media_url: "media/draft.jpg",
          poster_url: null,
          watermarked: false,
          like_count: 3,
          published_at: "2026-07-10T00:00:00.000Z",
        },
      },
    ];
    global.fetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === "/api/posts/media") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { items: [], expiresAt: "2026-08-01T00:00:00.000Z" } }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    }) as unknown as typeof fetch;

    const { container } = render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.querySelector(".post-media-web img")).toBeNull();
  });
});

// ===========================================================================
// ENG-762 / ENG-815 — the multi-photo carousel, rendered through SavedFeed's
// REAL mapper. Not a hand-built FeedPost/PostCard render: bypassing the mapper
// is exactly the bug class ENG-772 exists to catch. `slideCount` now rides in
// on the SAME /api/posts/media batch the ENG-799 mint tests above already
// stub, and slides 1+ mint one at a time by `{ postId, slideIndex }` through
// that same route (ENG-809 decision 2) — there is no more client-side
// `post_media` read to mock.
// ===========================================================================
describe("SavedFeed — ENG-762 multi-photo carousel", () => {
  function fetchWithCarousel(slideCount: number) {
    bookmarkData = [
      {
        created_at: "2026-07-12T00:00:00.000Z",
        post: {
          id: "p1",
          horse_id: "h1",
          type: "photo",
          body: "Trackwork.",
          media_url: "media/p1.jpg",
          poster_url: null,
          watermarked: false,
          like_count: 3,
          published_at: "2026-07-10T00:00:00.000Z",
        },
      },
    ];
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
              items: [{ postId: "p1", mediaUrl: "https://sb.local/p1-0.jpg", slideCount }],
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
    });
  }

  it("renders the multi-photo carousel (ENG-762 / ENG-815)", async () => {
    const fetchMock = fetchWithCarousel(3);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    expect(screen.getAllByTestId("photo-slide")).toHaveLength(3);
    expect(screen.getByTestId("photo-dots").querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/3");

    // WHICH IDS the screen actually asked for, on the SAME batch that carries
    // slideCount — the ENG-772 silent-drop class, moved onto the mint path.
    const mediaCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/posts/media");
    const batch = mediaCalls
      .map((c) => JSON.parse(String(c[1]?.body)))
      .find((b) => "postIds" in b);
    expect(batch).toEqual({ postIds: ["p1"] });
  });

  it("renders no carousel for a single-photo post (ENG-762 / ENG-815)", async () => {
    global.fetch = fetchWithCarousel(1) as unknown as typeof fetch;

    render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Nature Strip");

    expect(screen.queryByTestId("photo-dots")).toBeNull();
    expect(screen.queryByTestId("photo-track")).toBeNull();
  });
});
