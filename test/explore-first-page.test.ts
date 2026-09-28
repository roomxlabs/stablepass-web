import { describe, it, expect, vi, beforeEach } from "vitest";

// A chainable Supabase-style query builder mock, same shape as
// test/explore-feed.test.tsx's own `chainable()`: every filter method returns
// itself, and it resolves via `.then`.
function chainable(data: unknown[] = [], error: unknown = null) {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order"]) obj[method] = vi.fn(() => obj);
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(onFulfilled, onRejected);
  return obj;
}

const { getSessionMock, fromMock, storageFromMock } = vi.hoisted(() => {
  const getSessionMock = vi.fn(async () => ({ data: { session: { access_token: "t" } } }));
  const fromMock = vi.fn((_table: string) => chainableFallback());
  const storageFromMock = vi.fn((_bucket: string) => ({
    createSignedUrls: vi.fn(async (paths: string[]) => ({
      data: paths.map((path) => ({ path, signedUrl: `https://sb.local/signed/${path}` })),
    })),
  }));
  function chainableFallback() {
    const obj: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "order"]) obj[m] = vi.fn(() => obj);
    obj.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(onF, onR);
    return obj;
  }
  return { getSessionMock, fromMock, storageFromMock };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getSession: getSessionMock },
    from: fromMock,
    storage: { from: storageFromMock },
  })),
}));

import { loadExploreFirstPage } from "@/lib/feed/explore-first-page";

function jsonRes(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Every request this module can make, dispatched by URL. */
function makeFetch(opts: {
  feed?: { status: number; body: unknown };
  postMedia?: { status: number; body: unknown };
  playback?: { status: number; body: unknown };
  throwOnFeed?: boolean;
}) {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (opts.throwOnFeed && url.includes("/functions/v1/feed")) {
      throw new Error("network down");
    }
    if (url.includes("/functions/v1/feed")) {
      const { status, body } = opts.feed!;
      return jsonRes(status, body);
    }
    if (url.includes("/functions/v1/post-media")) {
      const { status, body } = opts.postMedia!;
      return jsonRes(status, body);
    }
    if (url.includes("/functions/v1/playback")) {
      const { status, body } = opts.playback!;
      return jsonRes(status, body);
    }
    throw new Error(`unexpected fetch ${url} ${String(init?.body)}`);
  });
}

const PHOTO_ROW = {
  id: "p1",
  type: "photo",
  title: null,
  body: "hi",
  label: null,
  media_url: "media/p1.jpg",
  poster_url: null,
  aspect_ratio: null,
  watermarked: false,
  like_count: 1,
  published_at: "2026-07-10T00:00:00.000Z",
  subject: "horse",
  horse_id: "h1",
  source_trainer_id: null,
  byline: null,
};

const VIDEO_ROW = {
  id: "v1",
  type: "video",
  title: null,
  body: null,
  label: null,
  media_url: null,
  poster_url: "posters/v1.jpg",
  aspect_ratio: null,
  watermarked: false,
  like_count: 2,
  published_at: "2026-07-11T00:00:00.000Z",
  subject: "horse",
  horse_id: "h2",
  source_trainer_id: null,
  byline: null,
};

function callFor(fetchMock: ReturnType<typeof vi.fn>, urlIncludes: string) {
  const call = fetchMock.mock.calls.find((c) => String(c[0]).includes(urlIncludes));
  if (!call) throw new Error(`no fetch call matched ${urlIncludes}`);
  return { url: String(call[0]), init: call[1] as RequestInit | undefined };
}

describe("loadExploreFirstPage — ENG-1593 server-rendered page 1", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    getSessionMock.mockClear();
    fromMock.mockReset();
    fromMock.mockImplementation((table: string) => {
      if (table === "horse") return chainable([]);
      if (table === "trainer") return chainable([]);
      if (table === "reaction") return chainable([]);
      if (table === "bookmark") return chainable([]);
      return chainable([]);
    });
    storageFromMock.mockClear();
  });

  it("a 402 from the feed fn returns { kind: 'gated' } and mints NOTHING (no post-media, no playback)", async () => {
    const fetchMock = makeFetch({ feed: { status: 402, body: { error: { code: "subscription_required" } } } });
    global.fetch = fetchMock as unknown as typeof fetch;

    const page = await loadExploreFirstPage();

    expect(page).toEqual({ kind: "gated" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/functions/v1/post-media"))).toBe(false);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/functions/v1/playback"))).toBe(false);
  });

  it("a clean page assembles a photo row + a video row from the edge fns, as the member's own token", async () => {
    const fetchMock = makeFetch({
      feed: {
        status: 200,
        body: {
          data: [PHOTO_ROW, VIDEO_ROW],
          meta: { nextCursor: "c2", hasMore: true },
        },
      },
      postMedia: {
        status: 200,
        body: { data: { items: [{ postId: "p1", mediaUrl: "https://sb.local/p1.jpg" }], expiresAt: "x" } },
      },
      playback: {
        status: 200,
        body: { data: { posterUrl: "https://sb.local/poster-v1.jpg" } },
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const page = await loadExploreFirstPage();

    expect(page?.kind).toBe("ok");
    if (page?.kind !== "ok") throw new Error("expected an ok page");
    expect(page.nextCursor).toBe("c2");
    expect(page.hasMore).toBe(true);

    const p1 = page.posts.find((p) => p.id === "p1");
    const v1 = page.posts.find((p) => p.id === "v1");
    expect(p1?.media.posterUrl).toBe("https://sb.local/p1.jpg");
    expect(v1?.media.posterUrl).toBe("https://sb.local/poster-v1.jpg");

    // The feed request: limit=10, and Explore never opts into Shares.
    const feedCall = callFor(fetchMock, "/functions/v1/feed");
    expect(feedCall.url).toContain("limit=10");
    expect(feedCall.url).not.toMatch(/shares=/);
    expect((feedCall.init?.headers as Record<string, string>).Authorization).toBe("Bearer t");

    // The batch asks for ONLY the photo id — the video took the poster path.
    const postMediaCall = callFor(fetchMock, "/functions/v1/post-media");
    expect(JSON.parse(String(postMediaCall.init?.body))).toEqual({ postIds: ["p1"] });

    // The poster call: { postId, posterOnly: true } — never a batch.
    const playbackCall = callFor(fetchMock, "/functions/v1/playback");
    expect(JSON.parse(String(playbackCall.init?.body))).toEqual({ postId: "v1", posterOnly: true });
  });

  it("a non-402, non-ok feed response (500) returns null — the client fetch is the fallback", async () => {
    const fetchMock = makeFetch({ feed: { status: 500, body: { error: { code: "feed_failed" } } } });
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await loadExploreFirstPage()).toBeNull();
  });

  it("a 402 from post-media (mid-assembly) still surfaces as { kind: 'gated' }", async () => {
    const fetchMock = makeFetch({
      feed: { status: 200, body: { data: [PHOTO_ROW], meta: { nextCursor: null, hasMore: false } } },
      postMedia: { status: 402, body: { error: { code: "subscription_required" } } },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await loadExploreFirstPage()).toEqual({ kind: "gated" });
  });

  it("any thrown/rejected fetch (network failure) returns null, never a crash", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = makeFetch({ feed: { status: 200, body: {} }, throwOnFeed: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(await loadExploreFirstPage()).toBeNull();
    consoleError.mockRestore();
  });
});
