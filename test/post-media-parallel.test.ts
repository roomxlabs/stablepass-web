import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolvePostDisplayUrls,
  bffPostMediaTransport,
  PostMediaError,
  type PostMediaTransport,
} from "@/lib/api/post-media";

beforeEach(() => {
  vi.restoreAllMocks();
});

/** A promise this test resolves on its own schedule, to prove call ORDER. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("resolvePostDisplayUrls — ENG-1593 the photo batch and video posters run TOGETHER", () => {
  it("calls transport.poster(videoId) WITHOUT waiting for the batch promise to resolve", async () => {
    const batchGate = deferred<Response>();
    const posterCalls: string[] = [];

    const transport: PostMediaTransport = {
      batch: vi.fn(() => batchGate.promise),
      poster: vi.fn((postId: string) => {
        posterCalls.push(postId);
        return Promise.resolve(
          jsonResponse(200, { data: { posterUrl: "https://sb.local/poster-v1.jpg" } }),
        );
      }),
    };

    const resultPromise = resolvePostDisplayUrls(
      [{ id: "v1", type: "video", poster_url: "posters/v1.jpg", media_url: null }],
      transport,
    );

    // Flush microtasks without ever resolving the batch — the poster call
    // must already have fired, since the two never depended on each other.
    await Promise.resolve();
    await Promise.resolve();
    expect(posterCalls).toEqual(["v1"]);

    // Only NOW does the (still-pending) batch resolve.
    batchGate.resolve(jsonResponse(200, { data: { items: [], expiresAt: "x" } }));
    const result = await resultPromise;
    expect(result.urls.get("v1")).toBe("https://sb.local/poster-v1.jpg");
  });

  it("merges a photo batch item (url + slideCount) with a video poster from the SAME resolve", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(async () =>
        jsonResponse(200, {
          data: {
            items: [{ postId: "p1", mediaUrl: "https://sb.local/p1.jpg", slideCount: 3 }],
            expiresAt: "x",
          },
        }),
      ),
      poster: vi.fn(async () =>
        jsonResponse(200, { data: { posterUrl: "https://sb.local/poster-v1.jpg" } }),
      ),
    };

    const result = await resolvePostDisplayUrls(
      [
        { id: "p1", type: "photo", media_url: "media/p1.jpg", poster_url: null },
        { id: "v1", type: "video", poster_url: "posters/v1.jpg", media_url: null },
      ],
      transport,
    );

    expect(result.urls.get("p1")).toBe("https://sb.local/p1.jpg");
    expect(result.slideCounts.get("p1")).toBe(3);
    expect(result.urls.get("v1")).toBe("https://sb.local/poster-v1.jpg");
    // The photo never went through the poster path, and vice versa.
    expect(transport.poster).toHaveBeenCalledTimes(1);
    expect(transport.poster).toHaveBeenCalledWith("v1");
  });

  it("a 402 from the POSTER rejects the whole resolve with PostMediaError('gated')", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(async () => jsonResponse(200, { data: { items: [], expiresAt: "x" } })),
      poster: vi.fn(async () => jsonResponse(402, { error: { code: "subscription_required" } })),
    };

    await expect(
      resolvePostDisplayUrls(
        [{ id: "v1", type: "video", poster_url: "posters/v1.jpg", media_url: null }],
        transport,
      ),
    ).rejects.toMatchObject({ name: "PostMediaError", reason: "gated" });
    expect(PostMediaError).toBeDefined();
  });

  it("an absolute URL passes through WITHOUT calling the transport at all", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(),
      poster: vi.fn(),
    };

    const result = await resolvePostDisplayUrls(
      [{ id: "p1", type: "photo", media_url: "https://placehold.co/x", poster_url: null }],
      transport,
    );

    expect(result.urls.get("p1")).toBe("https://placehold.co/x");
    expect(transport.batch).not.toHaveBeenCalled();
    expect(transport.poster).not.toHaveBeenCalled();
  });
});

describe("resolvePostDisplayUrls — ENG-1599 a video post's batch videoCount", () => {
  it("lands { postId, videoCount: 3 } in slideCounts and never in urls", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(async () =>
        jsonResponse(200, { data: { items: [{ postId: "v1", videoCount: 3 }], expiresAt: "x" } }),
      ),
      poster: vi.fn(),
    };

    const result = await resolvePostDisplayUrls(
      [{ id: "v1", type: "video", poster_url: null, media_url: null }],
      transport,
    );

    // The video post rides in the SAME batch, by id only.
    expect(transport.batch).toHaveBeenCalledTimes(1);
    expect(transport.batch).toHaveBeenCalledWith(["v1"]);
    expect(result.slideCounts.get("v1")).toBe(3);
    expect(result.urls.has("v1")).toBe(false);
  });

  it("keeps the poster url and adds the count when the video post also has a baked poster", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(async () =>
        jsonResponse(200, { data: { items: [{ postId: "v1", videoCount: 2 }], expiresAt: "x" } }),
      ),
      poster: vi.fn(async () => jsonResponse(200, { data: { posterUrl: "https://sb.local/poster-v1.jpg" } })),
    };

    const result = await resolvePostDisplayUrls(
      [{ id: "v1", type: "video", poster_url: "posters/v1.jpg", media_url: null }],
      transport,
    );

    expect(result.slideCounts.get("v1")).toBe(2);
    expect(result.urls.get("v1")).toBe("https://sb.local/poster-v1.jpg");
  });
});

describe("bffPostMediaTransport — the default, no-arg transport goes through global fetch", () => {
  it("mints the batch via EXACTLY /api/posts/media, POST, body { postIds } only", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(200, { data: { items: [], expiresAt: "x" } }),
    ) as unknown as typeof fetch;

    await resolvePostDisplayUrls([{ id: "p1", type: "photo", media_url: "media/p1.jpg", poster_url: null }]);

    expect(global.fetch).toHaveBeenCalledWith("/api/posts/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postIds: ["p1"] }),
    });
    const body = JSON.parse(
      String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]?.body),
    );
    // The ENTIRE body is postIds — never a path, never a `paths` key either.
    expect(Object.keys(body)).toEqual(["postIds"]);
  });

  it("mints a video poster via EXACTLY /api/posts/<id>/playback?posterOnly=1", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(200, { data: { posterUrl: "https://sb.local/poster.jpg" } }),
    ) as unknown as typeof fetch;

    await resolvePostDisplayUrls([
      { id: "v1", type: "video", poster_url: "posters/v1.jpg", media_url: null },
    ]);

    expect(global.fetch).toHaveBeenCalledWith("/api/posts/v1/playback?posterOnly=1");
  });

  it("the exported transport itself is wired the same way", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(200, { data: { items: [], expiresAt: "x" } }),
    ) as unknown as typeof fetch;

    await bffPostMediaTransport.batch(["p1", "p2"]);

    expect(global.fetch).toHaveBeenCalledWith("/api/posts/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postIds: ["p1", "p2"] }),
    });
  });
});
