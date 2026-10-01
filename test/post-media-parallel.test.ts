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

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const batchOf = (items: unknown[]) => jsonResponse(200, { data: { items, expiresAt: "x" } });
const posterOk = (id: string) =>
  jsonResponse(200, { data: { posterUrl: `https://sb.local/fallback-${id}.jpg` } });
const videoRow = (id: string, poster_url: string | null = `posters/${id}.jpg`) =>
  ({ id, type: "video", poster_url, media_url: null }) as const;

describe("resolvePostDisplayUrls — ENG-1633 video posters come from the ONE batch", () => {
  it("(i) batch video items with posterUrl: transport.poster is NEVER called", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(async () =>
        batchOf([
          { postId: "v1", videoCount: 1, posterUrl: "https://sb.local/batch-v1.jpg", posterExpiresAt: "x" },
          { postId: "v2", videoCount: 2, posterUrl: "https://sb.local/batch-v2.jpg", posterExpiresAt: "x" },
        ]),
      ),
      poster: vi.fn(),
    };
    const result = await resolvePostDisplayUrls([videoRow("v1"), videoRow("v2")], transport);
    expect(transport.batch).toHaveBeenCalledTimes(1);
    expect(transport.poster).not.toHaveBeenCalled();
    expect(result.urls.get("v1")).toBe("https://sb.local/batch-v1.jpg");
    expect(result.urls.get("v2")).toBe("https://sb.local/batch-v2.jpg");
    expect(result.slideCounts.get("v2")).toBe(2);
  });

  it("(ii) a video item with posterUrl null falls back to transport.poster for exactly that id", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(async () =>
        batchOf([
          { postId: "v1", videoCount: 1, posterUrl: "https://sb.local/batch-v1.jpg", posterExpiresAt: "x" },
          { postId: "v2", videoCount: 1, posterUrl: null, posterExpiresAt: null },
        ]),
      ),
      poster: vi.fn(async (id: string) => posterOk(id)),
    };
    const result = await resolvePostDisplayUrls([videoRow("v1"), videoRow("v2")], transport);
    expect(transport.poster).toHaveBeenCalledTimes(1);
    expect(transport.poster).toHaveBeenCalledWith("v2");
    expect(result.urls.get("v1")).toBe("https://sb.local/batch-v1.jpg");
    expect(result.urls.get("v2")).toBe("https://sb.local/fallback-v2.jpg");
  });

  it("(iii) a batch 402 rejects PostMediaError('gated') and the poster is never called", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(async () => jsonResponse(402, { error: { code: "subscription_required" } })),
      poster: vi.fn(async (id: string) => posterOk(id)),
    };
    await expect(resolvePostDisplayUrls([videoRow("v1")], transport)).rejects.toMatchObject({
      name: "PostMediaError",
      reason: "gated",
    });
    expect(transport.poster).not.toHaveBeenCalled();
  });

  it("(iv) a batch 500 falls back to transport.poster for every video with a poster key", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(async () => jsonResponse(500, {})),
      poster: vi.fn(async (id: string) => posterOk(id)),
    };
    const result = await resolvePostDisplayUrls(
      [videoRow("v1"), videoRow("v2"), videoRow("v3", null)],
      transport,
    );
    expect((transport.poster as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort()).toEqual([
      "v1",
      "v2",
    ]);
    expect(result.urls.get("v1")).toBe("https://sb.local/fallback-v1.jpg");
    expect(result.urls.get("v2")).toBe("https://sb.local/fallback-v2.jpg");
    expect(result.urls.has("v3")).toBe(false);
  });

  it("(v) a video row with NO poster key but a batch poster uses the batch poster, never calls poster", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(async () =>
        batchOf([{ postId: "v1", videoCount: 1, posterUrl: "https://sb.local/batch-v1.jpg", posterExpiresAt: "x" }]),
      ),
      poster: vi.fn(),
    };
    const result = await resolvePostDisplayUrls([videoRow("v1", null)], transport);
    expect(result.urls.get("v1")).toBe("https://sb.local/batch-v1.jpg");
    expect(transport.poster).not.toHaveBeenCalled();
  });

  it("a fallback poster 402 still rejects the resolve as 'gated'", async () => {
    const transport: PostMediaTransport = {
      batch: vi.fn(async () => batchOf([{ postId: "v1", videoCount: 1, posterUrl: null, posterExpiresAt: null }])),
      poster: vi.fn(async () => jsonResponse(402, { error: { code: "subscription_required" } })),
    };
    await expect(resolvePostDisplayUrls([videoRow("v1")], transport)).rejects.toMatchObject({ reason: "gated" });
  });
});

describe("resolvePostDisplayUrls — the photo batch and video posters still merge from ONE resolve", () => {
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
