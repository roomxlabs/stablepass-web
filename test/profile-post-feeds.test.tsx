// ENG-613 (W2) — the horse- and trainer-profile feeds. Scope decision 7: these
// two inherit the reorder and the name rule automatically, because both are
// global to `.post-web`. That is intended, so it is VERIFIED here rather than
// scoped out — "it should just work" is exactly the claim that needs a test.
//
// The trainer profile additionally SUPPRESSES the Follow pill: offering "Follow"
// on the page you are already reading is noise.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { HorsePosts } from "@/app/(member)/horses/[id]/horse-posts";
import { TrainerPosts } from "@/app/(member)/trainers/[id]/trainer-posts";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

let feedRows: unknown[];

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ from: fromMock }) }));

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

function chainable(result: { data: unknown; error: null }) {
  const obj: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "not", "order"]) obj[m] = vi.fn(() => obj);
  obj.delete = vi.fn(() => obj);
  obj.insert = vi.fn(() => Promise.resolve({ error: null }));
  obj.upsert = vi.fn(() => Promise.resolve({ error: null }));
  obj.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onF, onR);
  return obj;
}

/** A STABLE UPDATE row: `type: "text"`, a title, and a two-paragraph body. */
const TEXT_ROW = {
  id: "p1",
  type: "text",
  title: "Where the team is up to",
  body: "Quiet week here.\n\nBanjo's Girl trials Tuesday.",
  label: null,
  media_url: null,
  poster_url: null,
  aspect_ratio: null,
  watermarked: false,
  like_count: 4,
  published_at: "2026-07-10T00:00:00.000Z",
  horse_id: "h1",
  horse: { display_name: "Mahogany", racing_name: "Mahogany" },
};

beforeEach(() => {
  feedRows = [TEXT_ROW];
  photosMock = new Map();
  fromMock.mockReset();
  fromMock.mockImplementation(() => chainable({ data: [], error: null }));
  global.fetch = vi.fn((input: string | URL) => {
    const url = String(input);
    if (url.includes("/feed")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: feedRows }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
  }) as unknown as typeof fetch;
});

describe("HorsePosts — ENG-613 parity on the horse profile", () => {
  it("maps post.title and draws the STABLE UPDATE card with the stable footer", async () => {
    render(
      <HorsePosts
        horseId="h1"
        horseName="Mahogany"
        trainerName="Tom Alcott"
        stableName="Tom Alcott Racing"
        stableLocation="Sydney"
        viewerId={VIEWER_ID}
      />,
    );

    // 18 Aug: neither the pill nor the title renders — the panel is the
    // card's face, and the horse heads the card from the headline.
    expect(await screen.findByText("Quiet week here.")).toBeInTheDocument();
    expect(document.querySelector(".post-title")).toBeNull();
    expect(document.querySelector(".post-badge")).toBeNull();
    // The footer arrives as PROPS from the page (which already selects both
    // columns), not from a trainer read this screen makes for itself.
    expect(document.querySelector(".post-panel-foot")!.textContent).toContain("Tom Alcott Racing · Sydney");
  });

  it("omits the panel footer when the page has neither stable column", async () => {
    render(<HorsePosts horseId="h1" horseName="Mahogany" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);

    await screen.findByText("Quiet week here.");
    expect(document.querySelector(".post-panel")).not.toBeNull();
    expect(document.querySelector(".post-panel-foot")).toBeNull();
  });

  it("puts the caption below the reaction bar on a media post", async () => {
    feedRows = [{ ...TEXT_ROW, type: "photo", title: null, body: "Trackwork this morning." }];

    render(<HorsePosts horseId="h1" horseName="Mahogany" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);
    await screen.findByText("Trackwork this morning.");

    const children = Array.from(document.querySelector("article.post-web")!.children);
    const actions = children.findIndex((el) => el.classList.contains("post-actions-web"));
    const body = children.findIndex((el) => el.classList.contains("post-body-web"));
    expect(actions).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThan(actions);
  });

  // A data-layer projection test (test/horses-route.test.ts) cannot see a
  // dropped mapper field, and this render test cannot see a wrong projection
  // — ENG-772 needed both, because the bug lived in each layer.
  it("renders the green label pill on a horse-profile card (ENG-772)", async () => {
    feedRows = [{ ...TEXT_ROW, label: "Trackwork" }];

    render(<HorsePosts horseId="h1" horseName="Mahogany" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);

    expect(await screen.findByText("Trackwork")).toBeInTheDocument();
    expect(document.querySelector(".post-badge")!.textContent).toBe("Trackwork");
  });

  // ENG-762 — the multi-photo carousel, rendered through HorsePosts' REAL
  // mapper (not a hand-built FeedPost/PostCard render, which would bypass
  // the exact mapper bug class ENG-772 exists to catch).
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
    feedRows = [{ ...TEXT_ROW, type: "photo", title: null, body: "Trackwork this morning." }];

    render(<HorsePosts horseId="h1" horseName="Mahogany" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);
    await screen.findByText("Trackwork this morning.");

    expect(screen.getAllByTestId("photo-slide")).toHaveLength(3);
    expect(screen.getByTestId("photo-dots").querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/3");
  });

  it("renders no carousel for a single-photo post (ENG-762)", async () => {
    photosMock = new Map([["p1", [{ url: "https://signed.test/p1-0.jpg", sort: 0 }]]]);
    feedRows = [{ ...TEXT_ROW, type: "photo", title: null, body: "Trackwork this morning." }];

    render(<HorsePosts horseId="h1" horseName="Mahogany" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);
    await screen.findByText("Trackwork this morning.");

    expect(screen.queryByTestId("photo-dots")).toBeNull();
    expect(screen.queryByTestId("photo-track")).toBeNull();
  });
});

describe("TrainerPosts — ENG-613 parity on the trainer profile", () => {
  it("maps post.title and draws the STABLE UPDATE card with the stable footer", async () => {
    render(
      <TrainerPosts
        trainerId="t1"
        trainerName="Tom Alcott"
        stableName="Tom Alcott Racing"
        stableLocation="Sydney"
        viewerId={VIEWER_ID}
      />,
    );

    // 18 Aug: neither the pill nor the title renders — the panel is the card's face.
    expect(await screen.findByText("Quiet week here.")).toBeInTheDocument();
    expect(document.querySelector(".post-title")).toBeNull();
    expect(document.querySelector(".post-badge")).toBeNull();
    expect(document.querySelector(".post-panel-foot")!.textContent).toContain("Tom Alcott Racing · Sydney");
  });

  // NOT vacuous: a card IS on screen (asserted first), and the pill is offered
  // on Explore and Following from the same component. Its absence here is a
  // property of this surface.
  it("offers no Follow pill on the trainer's own profile feed", async () => {
    feedRows = [{ ...TEXT_ROW, type: "photo", title: null, body: "Trackwork." }];

    render(<TrainerPosts trainerId="t1" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);
    await screen.findByText("Trackwork.");

    expect(document.querySelector(".post-media-web")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Follow / })).not.toBeInTheDocument();
  });

  // A data-layer projection test (test/trainers-route.test.ts) cannot see a
  // dropped mapper field, and this render test cannot see a wrong projection
  // — ENG-772 needed both, because the bug lived in each layer.
  it("renders the green label pill on a trainer-profile card (ENG-772)", async () => {
    feedRows = [{ ...TEXT_ROW, label: "Trackwork" }];

    render(<TrainerPosts trainerId="t1" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);

    expect(await screen.findByText("Trackwork")).toBeInTheDocument();
    expect(document.querySelector(".post-badge")!.textContent).toBe("Trackwork");
  });

  // ENG-762 — the multi-photo carousel, rendered through TrainerPosts' REAL
  // mapper (not a hand-built FeedPost/PostCard render, which would bypass
  // the exact mapper bug class ENG-772 exists to catch).
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
    feedRows = [{ ...TEXT_ROW, type: "photo", title: null, body: "Trackwork this morning." }];

    render(<TrainerPosts trainerId="t1" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);
    await screen.findByText("Trackwork this morning.");

    expect(screen.getAllByTestId("photo-slide")).toHaveLength(3);
    expect(screen.getByTestId("photo-dots").querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByTestId("media-photo-count")).toHaveTextContent("1/3");
  });

  it("renders no carousel for a single-photo post (ENG-762)", async () => {
    photosMock = new Map([["p1", [{ url: "https://signed.test/p1-0.jpg", sort: 0 }]]]);
    feedRows = [{ ...TEXT_ROW, type: "photo", title: null, body: "Trackwork this morning." }];

    render(<TrainerPosts trainerId="t1" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);
    await screen.findByText("Trackwork this morning.");

    expect(screen.queryByTestId("photo-dots")).toBeNull();
    expect(screen.queryByTestId("photo-track")).toBeNull();
  });
});
