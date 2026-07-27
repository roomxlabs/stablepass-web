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
const FEED_HORSES = [{ id: "fh1", display_name: "Mahogany", trainer: { name: "G. Waterhouse" } }];

let subStatus: string;
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
  subStatus = "trial";
  horseFollows = HORSE_FOLLOWS;
  trainerFollows = TRAINER_FOLLOWS;
  feedStatus = 200;
  feedPosts = FEED_POSTS;
  fromMock.mockReset();
  pushMock.mockClear();
  fromMock.mockImplementation((table: string) => {
    if (table === "subscription") return chainable({ data: { status: subStatus }, error: null });
    if (table === "follow") return followBuilder();
    if (table === "horse") return chainable({ data: FEED_HORSES, error: null });
    return chainable({ data: [], error: null }); // reaction, bookmark
  });
  global.fetch = fetchImpl() as unknown as typeof fetch;
});

describe("FollowingScreen", () => {
  it("renders the followed horses + trainers rails, newest-followed first, with avatar links to the profile", async () => {
    const user = userEvent.setup();
    render(<FollowingScreen viewerId={VIEWER_ID} />);

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
    render(<FollowingScreen viewerId={VIEWER_ID} />);

    expect(await screen.findByRole("button", { name: "Nature Strip" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Horses" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Trainers" })).not.toBeInTheDocument();
  });

  it("shows the follow prompt when the member follows nothing", async () => {
    horseFollows = [];
    trainerFollows = [];
    feedPosts = [];
    render(<FollowingScreen viewerId={VIEWER_ID} />);

    expect(await screen.findByText(/not following anyone yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nature Strip" })).not.toBeInTheDocument();
  });

  it("renders the following feed from /api/feed/following", async () => {
    render(<FollowingScreen viewerId={VIEWER_ID} />);
    expect(await screen.findByText("Mahogany")).toBeInTheDocument();
  });

  it("shows the reactivate prompt (and never the rails) when the subscription is lapsed", async () => {
    subStatus = "lapsed";
    feedStatus = 402;
    render(<FollowingScreen viewerId={VIEWER_ID} />);

    expect(await screen.findByText(/trial has ended/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Reactivate" })).toHaveAttribute("href", "/checkout");
    expect(screen.queryByRole("button", { name: "Nature Strip" })).not.toBeInTheDocument();
  });
});
