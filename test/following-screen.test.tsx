import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  return vi.fn((input: string | URL) => {
    const url = String(input);
    if (url.startsWith("/api/feed/seen")) return Promise.resolve({ ok: true, status: 204, json: async () => ({}) });
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
  // `sb` is untyped, so a dropped column is invisible to `tsc` and blanks the
  // panel footer at runtime instead.
  it("selects the trainer columns the pill and the panel footer need", async () => {
    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    const horseCallIndex = fromMock.mock.calls.findIndex((c) => c[0] === "horse");
    expect(horseCallIndex).toBeGreaterThanOrEqual(0);
    const chain = fromMock.mock.results[horseCallIndex].value as { select: ReturnType<typeof vi.fn> };
    const projection = chain.select.mock.calls[0][0] as string;

    for (const column of ["id", "name", "stable_name", "location"]) {
      expect(projection, `horse select must carry trainer.${column}`).toContain(column);
    }
  });

  it("puts post.title on the view model and draws the STABLE UPDATE card", async () => {
    feedPosts = [{ ...FEED_POSTS[0], type: "text", title: "Where the team is up to", body: "Quiet week here." }];

    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);

    expect(await screen.findByText("Where the team is up to")).toHaveClass("post-title");
    expect(screen.getByText("Stable update")).toHaveClass("post-badge");
  });

  // The feed post's trainer (`G. Waterhouse`) is NOT in TRAINER_FOLLOWS, which
  // only holds Chris Waller — exactly the followed-horse-unfollowed-trainer case.
  it("offers the pill for a post whose trainer is not followed", async () => {
    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Mahogany");

    expect(await screen.findByRole("button", { name: "Follow G. Waterhouse" })).toBeInTheDocument();
  });

  // A walled member is shown no content at all, so an "absent pill" assertion
  // would pass vacuously on the 402 path. Assert the absence of CARDS instead.
  it("renders no cards, and so no pill, when the feed is gated", async () => {
    feedStatus = 402;

    render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => {
      expect(document.querySelector("article.post-web")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
  });
});
