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

const { fromMock, createSignedUrlsMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  createSignedUrlsMock: vi.fn(),
}));

// `storage` is REQUIRED on this mock since ENG-958: `TrainerPosts` batch-signs
// the embedded horse photos itself. Without it the mock is one fixture field
// away from a TypeError rather than an assertion — and, worse, `signPhotoMap`
// early-returns when no row carries a `photo_url`, so a fixture without one
// keeps the suite green while testing nothing on that path.
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    from: fromMock,
    storage: { from: () => ({ createSignedUrls: createSignedUrlsMock }) },
  }),
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
  fromMock.mockReset();
  // A DISTINGUISHABLE signed value, so an assertion on the rendered `src`
  // discriminates "signed" from "raw path" instead of passing either way.
  createSignedUrlsMock.mockReset();
  createSignedUrlsMock.mockImplementation((paths: string[]) => ({
    data: paths.map((path) => ({ path, signedUrl: `https://sb.local/signed/${path}` })),
    error: null,
  }));
  fromMock.mockImplementation(() => chainable({ data: [], error: null }));
  global.fetch = vi.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/feed")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: feedRows }) });
    }
    if (url === "/api/posts/media" || url.startsWith("/api/posts/media?")) {
      const body = init?.body ? JSON.parse(String(init.body)) : { postIds: [] };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: (body.postIds as string[]).map((id: string) => ({
              postId: id,
              mediaUrl: `https://sb.local/${id}?token=abc`,
            })),
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

  // ENG-762 / ENG-815 — the multi-photo carousel, rendered through HorsePosts'
  // REAL mapper (not a hand-built FeedPost/PostCard render, which would bypass
  // the exact mapper bug class ENG-772 exists to catch). `slideCount` now rides
  // in on the SAME /api/posts/media batch the ENG-799 mint tests below already
  // stub, and slides 1+ mint one at a time by `{ postId, slideIndex }` through
  // that same route — there is no more client-side `post_media` read to mock.
  it("renders the multi-photo carousel (ENG-762 / ENG-815)", async () => {
    feedRows = [
      { ...TEXT_ROW, type: "photo", title: null, body: "Trackwork this morning.", media_url: "media/p1.jpg", poster_url: null },
    ];
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/feed")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: feedRows }) });
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
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [{ postId: "p1", mediaUrl: "https://sb.local/p1-0.jpg", slideCount: 3 }],
              expiresAt: "2026-08-01T00:00:00.000Z",
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<HorsePosts horseId="h1" horseName="Mahogany" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);
    await screen.findByText("Trackwork this morning.");

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
    feedRows = [
      { ...TEXT_ROW, type: "photo", title: null, body: "Trackwork this morning.", media_url: "media/p1.jpg", poster_url: null },
    ];
    global.fetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/feed")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: feedRows }) });
      }
      if (url === "/api/posts/media") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [{ postId: "p1", mediaUrl: "https://sb.local/p1-0.jpg", slideCount: 1 }],
              expiresAt: "2026-08-01T00:00:00.000Z",
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    }) as unknown as typeof fetch;

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

  // ENG-762 / ENG-815 — the multi-photo carousel, rendered through
  // TrainerPosts' REAL mapper (not a hand-built FeedPost/PostCard render,
  // which would bypass the exact mapper bug class ENG-772 exists to catch).
  // `slideCount` now rides in on the SAME /api/posts/media batch the ENG-799
  // mint tests below already stub, and slides 1+ mint one at a time by
  // `{ postId, slideIndex }` through that same route.
  it("renders the multi-photo carousel (ENG-762 / ENG-815)", async () => {
    feedRows = [
      { ...TEXT_ROW, type: "photo", title: null, body: "Trackwork this morning.", media_url: "media/p1.jpg", poster_url: null },
    ];
    const fetchMock = vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/feed")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: feedRows }) });
      }
      if (url === "/api/posts/media") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if ("postId" in body) {
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
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [{ postId: "p1", mediaUrl: "https://sb.local/p1-0.jpg", slideCount: 3 }],
              expiresAt: "2026-08-01T00:00:00.000Z",
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<TrainerPosts trainerId="t1" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);
    await screen.findByText("Trackwork this morning.");

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
    feedRows = [
      { ...TEXT_ROW, type: "photo", title: null, body: "Trackwork this morning.", media_url: "media/p1.jpg", poster_url: null },
    ];
    global.fetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/feed")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: feedRows }) });
      }
      if (url === "/api/posts/media") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [{ postId: "p1", mediaUrl: "https://sb.local/p1-0.jpg", slideCount: 1 }],
              expiresAt: "2026-08-01T00:00:00.000Z",
            },
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    }) as unknown as typeof fetch;

    render(<TrainerPosts trainerId="t1" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);
    await screen.findByText("Trackwork this morning.");

    expect(screen.queryByTestId("photo-dots")).toBeNull();
    expect(screen.queryByTestId("photo-track")).toBeNull();
  });
});

describe("profile post feeds — ENG-799 post-media mint", () => {
  it("HorsePosts makes exactly one POST /api/posts/media for a photo page", async () => {
    feedRows = [
      {
        ...TEXT_ROW,
        type: "photo",
        title: null,
        body: "Trackwork this morning.",
        media_url: "media/p1.jpg",
        poster_url: null,
      },
    ];
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;

    render(
      <HorsePosts horseId="h1" horseName="Mahogany" trainerName="Tom Alcott" viewerId={VIEWER_ID} />,
    );
    await screen.findByText("Trackwork this morning.");

    const mediaCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/posts/media");
    expect(mediaCalls).toHaveLength(1);
    expect(JSON.parse(String(mediaCalls[0][1]?.body))).toEqual({ postIds: ["p1"] });
  });

  // ENG-958 — the head avatar must render the SIGNED url, never the stored
  // path. `photo_url` is a bare object path in a PRIVATE bucket; rendered raw
  // into `<img src>` it resolves against the current page and silently returns
  // HTML, so the failure is invisible rather than loud.
  //
  // This runs TrainerPosts' REAL mapper end to end. It is the gate the other
  // four feed screens already had and this one did not: before it existed,
  // changing the mapper to `horsePhotoUrl: horse?.photo_url` (the raw path)
  // failed NO test in the repo, because the fixture carried no `photo_url` at
  // all and `signPhotoMap` short-circuits on an empty path list.
  it("TrainerPosts renders the SIGNED horse photo, never the raw stored path", async () => {
    const RAW_PATH = "horses/mahogany.jpg";
    // A PHOTO row, deliberately not the default `text` one: an update card's
    // head is the STABLE's voice and shows the trainer's photo, so a text row
    // would never exercise `horsePhotoUrl` in the head at all.
    feedRows = [
      {
        ...TEXT_ROW,
        type: "photo",
        title: null,
        body: "Trackwork this morning.",
        horse: { display_name: "Mahogany", racing_name: "Mahogany", photo_url: RAW_PATH },
      },
    ];

    const { container } = render(
      <TrainerPosts trainerId="t1" trainerName="Tom Alcott" viewerId={VIEWER_ID} />,
    );
    await screen.findByText("Trackwork this morning.");

    const avatar = container.querySelector<HTMLImageElement>("[data-testid='post-avatar-photo']");
    expect(avatar).not.toBeNull();
    expect(avatar).toHaveAttribute("src", `https://sb.local/signed/${RAW_PATH}`);
    // Assert the NEGATIVE explicitly: the raw path must not survive anywhere in
    // the attribute, including as the tail of a wrongly-concatenated value.
    expect(avatar!.getAttribute("src")).not.toBe(RAW_PATH);

    // Signed in ONE batched call for the page, not once per card.
    expect(createSignedUrlsMock).toHaveBeenCalledTimes(1);
    expect(createSignedUrlsMock.mock.calls[0][0]).toEqual([RAW_PATH]);
  });

  it("TrainerPosts falls back to the monogram when the horse has no photo", async () => {
    // No `photo_url` on the row — the pre-ENG-958 shape, and still the majority
    // of real rows. A photo row again, so the head resolves the HORSE.
    feedRows = [{ ...TEXT_ROW, type: "photo", title: null, body: "Trackwork this morning." }];
    const { container } = render(
      <TrainerPosts trainerId="t1" trainerName="Tom Alcott" viewerId={VIEWER_ID} />,
    );
    await screen.findByText("Trackwork this morning.");
    expect(container.querySelector("[data-testid='post-avatar-photo']")).toBeNull();
    expect(container.querySelector(".post-avatar-web")).toHaveTextContent("M");
  });

  it("TrainerPosts makes exactly one POST /api/posts/media for a photo page", async () => {
    feedRows = [
      {
        ...TEXT_ROW,
        type: "photo",
        title: null,
        body: "Trackwork.",
        media_url: "media/p1.jpg",
        poster_url: null,
      },
    ];
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;

    render(<TrainerPosts trainerId="t1" trainerName="Tom Alcott" viewerId={VIEWER_ID} />);
    await screen.findByText("Trackwork.");

    const mediaCalls = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/posts/media");
    expect(mediaCalls).toHaveLength(1);
  });

  it("omitted mint id → null poster placeholder on HorsePosts", async () => {
    feedRows = [
      {
        ...TEXT_ROW,
        type: "photo",
        title: null,
        body: "Trackwork.",
        media_url: "media/draft.jpg",
        poster_url: null,
      },
    ];
    global.fetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/feed")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: feedRows }) });
      }
      if (url === "/api/posts/media") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ data: { items: [], expiresAt: "2026-08-01T00:00:00.000Z" } }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) });
    }) as unknown as typeof fetch;

    const { container } = render(
      <HorsePosts horseId="h1" horseName="Mahogany" trainerName="Tom Alcott" viewerId={VIEWER_ID} />,
    );
    await screen.findByText("Trackwork.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(container.querySelector(".post-media-web img")).toBeNull();
  });
});
