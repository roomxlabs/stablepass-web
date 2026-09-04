import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FollowingScreen } from "@/app/(member)/following/following-screen";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

// Rails (newest-followed first): Nature Strip before Winx; one trainer.
const HORSE_FOLLOWS = [
  { created_at: "2026-07-12T00:00:00.000Z", horse: { id: "h1", display_name: "Nature Strip", racing_name: "Nature Strip", photo_url: null } },
  { created_at: "2026-07-11T00:00:00.000Z", horse: { id: "h2", display_name: "Winx", racing_name: "Winx", photo_url: null } },
];
const TRAINER_FOLLOWS = [
  { created_at: "2026-07-12T00:00:00.000Z", trainer: { id: "t1", name: "Chris Waller", display_name: null, photo_url: null } },
];
// Feed post enriches to a DISTINCT horse name so feed vs rail render is unambiguous.
const FEED_POSTS = [
  { id: "p1", horse_id: "fh1", type: "photo", body: "Trackwork.", media_url: null, watermarked: false, like_count: 3, published_at: "2026-07-10T00:00:00.000Z" },
];
// ENG-613: the trainer sub-select now carries `id` (the Follow pill keys on it —
// a name is not a key) plus `stable_name`/`location` for the panel footer.
const FEED_HORSES = [{ id: "fh1", display_name: "Mahogany", trainer: { id: "t9", name: "G. Waterhouse", stable_name: "Waterhouse Racing", location: "Randwick" } }];

let subRow: { status: string; trial_ends_at: string | null; current_period_end: string | null };
let horseFollows: unknown[];
let trainerFollows: unknown[];
let feedStatus: 200 | 402;
let feedPosts: unknown[];

const { fromMock, pushMock } = vi.hoisted(() => ({ fromMock: vi.fn(), pushMock: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ from: fromMock }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

// Generic chainable builder (subscription gate + feed enrichment).
function chainable(result: { data: unknown; error: null }) {
  const obj: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "not", "order"]) obj[m] = vi.fn(() => obj);
  obj.delete = vi.fn(() => obj);
  obj.maybeSingle = vi.fn(() => Promise.resolve(result));
  obj.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onF, onR);
  return obj;
}

// `follow` rail builder: resolves horse- vs trainer-follows by the `.not(<field>)` filter.
function followBuilder() {
  let target = "horse_id";
  const obj: Record<string, unknown> = {};
  obj.select = vi.fn(() => obj);
  obj.order = vi.fn(() => obj);
  obj.not = vi.fn((field: string) => { target = field; return obj; });
  obj.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve({ data: target === "horse_id" ? horseFollows : trainerFollows, error: null }).then(onF, onR);
  return obj;
}

function fetchImpl() {
  return vi.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/posts/media" || url.startsWith("/api/posts/media?")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [{ postId: "p1", mediaUrl: "https://sb.local/p1?token=abc" }],
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
    if (url.startsWith("/api/feed/following")) {
      if (feedStatus === 402) return Promise.resolve({ ok: false, status: 402, json: async () => ({ error: { code: "subscription_required" } }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: feedPosts, meta: { nextCursor: null, hasMore: false } }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
  });
}

beforeEach(() => {
  // Not-gated default: an in-flight trial (future `trial_ends_at`) — matches the
  // pre-ENG-585 default of `subStatus = "trial"` under the old status-only check.
  subRow = { status: "trial", trial_ends_at: "2099-01-01T00:00:00.000Z", current_period_end: null };
  horseFollows = HORSE_FOLLOWS;
  trainerFollows = TRAINER_FOLLOWS;
  feedStatus = 200;
  feedPosts = FEED_POSTS;
  fromMock.mockReset();
  pushMock.mockClear();
  fromMock.mockImplementation((table: string) => {
    if (table === "subscription") return chainable({ data: subRow, error: null });
    if (table === "follow") return followBuilder();
    if (table === "horse") return chainable({ data: FEED_HORSES, error: null });
    return chainable({ data: [], error: null }); // reaction, bookmark
  });
  global.fetch = fetchImpl() as unknown as typeof fetch;
});

describe("FollowingScreen", () => {
  it("renders the followed horses + trainers rails, newest-followed first, with avatar links to the profile", async () => {
    const user = userEvent.setup();
    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);

    expect(await screen.findByRole("button", { name: "Nature Strip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Winx" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Chris Waller" })).toBeInTheDocument();

    // Newest-followed first: Nature Strip (saved later) appears before Winx in the DOM.
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels.indexOf("Nature Strip")).toBeLessThan(labels.indexOf("Winx"));

    await user.click(screen.getByRole("button", { name: "Nature Strip" }));
    expect(pushMock).toHaveBeenCalledWith("/horses/h1");
  });

  it("hides an empty section (trainers empty → only the horses rail shows)", async () => {
    trainerFollows = [];
    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);

    expect(await screen.findByRole("button", { name: "Nature Strip" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Horses" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Trainers" })).not.toBeInTheDocument();
  });

  it("shows the follow prompt when the member follows nothing", async () => {
    horseFollows = [];
    trainerFollows = [];
    feedPosts = [];
    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);

    expect(await screen.findByText(/not following anyone yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nature Strip" })).not.toBeInTheDocument();
  });

  it("renders the following feed from /api/feed/following", async () => {
    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
    expect(await screen.findByText("Mahogany")).toBeInTheDocument();
  });

  it("shows the free-trial-ended wall (and never the rails) when the subscription is lapsed and the member never subscribed", async () => {
    subRow = { status: "lapsed", trial_ends_at: null, current_period_end: null };
    feedStatus = 402;
    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);

    expect(await screen.findByText(/your free trial has ended/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get full access" })).toHaveAttribute("href", "/checkout");
    expect(screen.queryByRole("button", { name: "Nature Strip" })).not.toBeInTheDocument();
  });

  it("shows the access-paused wall (and never the rails) when the subscription is lapsed and the member has subscribed before", async () => {
    subRow = { status: "lapsed", trial_ends_at: null, current_period_end: null };
    feedStatus = 402;
    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={true} />);

    expect(await screen.findByText(/your access has paused/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy 30 days" })).toHaveAttribute("href", "/checkout");
    expect(screen.queryByRole("button", { name: "Nature Strip" })).not.toBeInTheDocument();
  });

  describe("aspect ratio (ENG-612)", () => {
    const ratioOf = (el: HTMLElement): number => {
      const [w, h = "1"] = el.style.aspectRatio.split("/").map((part) => part.trim());
      return Number(w) / Number(h);
    };

    it("a 16:9 aspect_ratio (1.7778) renders the wide box unclamped", async () => {
      feedPosts = [{ ...FEED_POSTS[0], aspect_ratio: 1.7778 }];
      const { container } = render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
      await screen.findByText("Mahogany");

      const box = container.querySelector<HTMLElement>(".post-media-web");
      expect(box).toBeTruthy();
      expect(ratioOf(box!)).toBeCloseTo(1.7778, 4);
      expect(box!.className).toBe("post-media-web");
    });

    it("a 9:16 reel aspect_ratio (0.5625) clamps to the tall bucket (ASPECT_MIN 0.8)", async () => {
      feedPosts = [{ ...FEED_POSTS[0], aspect_ratio: 0.5625 }];
      const { container } = render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
      await screen.findByText("Mahogany");

      const box = container.querySelector<HTMLElement>(".post-media-web");
      expect(box).toBeTruthy();
      expect(ratioOf(box!)).toBeCloseTo(0.8, 4);
      expect(box!.className).toBe("post-media-web tall");
    });

    it("a null aspect_ratio falls back to ASPECT_DEFAULT (1.6)", async () => {
      feedPosts = [{ ...FEED_POSTS[0], aspect_ratio: null }];
      const { container } = render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
      await screen.findByText("Mahogany");

      const box = container.querySelector<HTMLElement>(".post-media-web");
      expect(box).toBeTruthy();
      expect(ratioOf(box!)).toBeCloseTo(1.6, 4);
      expect(box!.className).toBe("post-media-web");
    });
  });
});

// ===========================================================================
// ENG-613 (W2) — the mapper feeds the parity card. The Following feed also
// carries posts from followed HORSES, whose trainer may be unfollowed, so the
// Follow pill is meaningful here and is not merely inherited from Explore.
// ===========================================================================
describe("FollowingScreen — ENG-613 view model + Follow pill", () => {
  // Sibling of the describe above, so ITS beforeEach does not run here.
  // Without this, mock call HISTORY leaks in and the projection lookup below
  // can resolve to an earlier test's `from("horse")` call.
  beforeEach(() => {
    fromMock.mockClear();
  });

  // `sb` is untyped, so a dropped column is invisible to `tsc` and blanks the
  // panel footer at runtime instead.
  it("selects the trainer columns the pill and the panel footer need", async () => {
    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
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

  it("puts post.title on the view model and draws the STABLE UPDATE card", async () => {
    feedPosts = [{ ...FEED_POSTS[0], type: "text", title: "Where the team is up to", body: "Quiet week here." }];

    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);

    // 18 Aug: neither the pill nor the title renders — the panel is the card's face.
    expect(await screen.findByText("Quiet week here.")).toBeInTheDocument();
    expect(document.querySelector(".post-title")).toBeNull();
    expect(document.querySelector(".post-badge")).toBeNull();
  });

  // ROUND 6 / ENG-761 item 4 — the Following screen offers NO Follow pill,
  // ever, not even here: a post surfaced via a FOLLOWED horse (Mahogany) whose
  // trainer (`G. Waterhouse`) is itself unfollowed (only Chris Waller is in
  // TRAINER_FOLLOWS) — exactly the case row 5's pill used to cover pre-round-6.
  // `canFollowTrainer()` is now a constant `false` and PostCard is never given
  // `canFollow`/`onFollow` on this screen, by design (see following-screen.tsx).
  it("shows no pill even for a post whose trainer is unfollowed — Following never offers Follow", async () => {
    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
  });

  // ROUND 6 / ENG-761 item 1 — `post.label` (ENG-738's 13 presets, or null)
  // read at the DATA LAYER: the row carries it, the mapper puts it on the view
  // model, and the card draws it as the `.post-badge` pill.
  it("puts post.label on the view model and renders it as the pill", async () => {
    feedPosts = [{ ...FEED_POSTS[0], label: "Race Replay" }];

    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    const badge = document.querySelector(".post-badge");
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe("Race Replay");
  });

  it("renders no pill when the row's label is null", async () => {
    feedPosts = [{ ...FEED_POSTS[0], label: null }];

    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(document.querySelector(".post-badge")).toBeNull();
  });

  // A walled member is shown no content at all, so an "absent pill" assertion
  // would pass vacuously on the 402 path. Assert the absence of CARDS instead.
  it("renders no cards, and so no pill, when the feed is gated", async () => {
    feedStatus = 402;

    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);

    // POSITIVE anchor first — see the note in test/explore-feed.test.tsx. An
    // all-negative assertion on a gated screen passes on a blank page and
    // proves nothing.
    expect(await screen.findByText("Your free trial has ended")).toBeInTheDocument();

    expect(document.querySelector("article.post-web")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
  });
});

// ===========================================================================
// ENG-799 — post-media mint via BFF (no client createSignedUrls)
// ===========================================================================
describe("FollowingScreen — ENG-799 post-media mint", () => {
  it("makes exactly one POST /api/posts/media for a photo page", async () => {
    feedPosts = [
      { id: "p1", horse_id: "fh1", type: "photo", body: "Trackwork.", media_url: "media/p1.jpg", poster_url: null, watermarked: false, like_count: 3, published_at: "2026-07-10T00:00:00.000Z" },
    ];
    const fetchMock = fetchImpl();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    const mediaCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/posts/media");
    expect(mediaCalls).toHaveLength(1);
    expect(JSON.parse(String(mediaCalls[0][1]?.body))).toEqual({ postIds: ["p1"] });
  });

  it("omitted mint id → placeholder, not an error", async () => {
    feedPosts = [
      { id: "p1", horse_id: "fh1", type: "photo", body: "Trackwork.", media_url: "media/draft.jpg", poster_url: null, watermarked: false, like_count: 3, published_at: "2026-07-10T00:00:00.000Z" },
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
      if (url.startsWith("/api/feed/following")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: feedPosts, meta: { nextCursor: null, hasMore: false } }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    }) as unknown as typeof fetch;

    const { container } = render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.querySelector(".post-media-web img")).toBeNull();
  });
});

// ===========================================================================
// ENG-762 / ENG-815 — the multi-photo carousel, rendered through
// FollowingScreen's REAL mapper. Not a hand-built FeedPost/PostCard render:
// bypassing the mapper is exactly the bug class ENG-772 exists to catch.
// `slideCount` now rides in on the SAME /api/posts/media batch the ENG-799
// mint tests above already stub, and slides 1+ mint one at a time by
// `{ postId, slideIndex }` through that same route (ENG-809 decision 2) —
// there is no more client-side `post_media` read to mock.
// ===========================================================================
describe("FollowingScreen — ENG-762 multi-photo carousel", () => {
  function fetchWithCarousel(slideCount: number) {
    feedPosts = [
      { id: "p1", horse_id: "fh1", type: "photo", body: "Trackwork.", media_url: "media/p1.jpg", poster_url: null, watermarked: false, like_count: 3, published_at: "2026-07-10T00:00:00.000Z" },
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
      if (url.startsWith("/api/feed/following")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: feedPosts, meta: { nextCursor: null, hasMore: false } }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });
  }

  it("renders the multi-photo carousel (ENG-762 / ENG-815)", async () => {
    const fetchMock = fetchWithCarousel(3);
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

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

    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(screen.queryByTestId("photo-dots")).toBeNull();
    expect(screen.queryByTestId("photo-track")).toBeNull();
  });
});
