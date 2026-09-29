import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { getUserMock, edgeFetchMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  edgeFetchMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
  })),
}));

vi.mock("@/lib/api/edge", () => ({
  edgeFetch: edgeFetchMock,
}));

import { GET, POST } from "@/app/api/posts/[id]/playback/route";

function fakeRes(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("/api/posts/:id/playback", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    edgeFetchMock.mockReset();
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await GET(new Request("http://localhost/api/posts/p1/playback"), params("p1"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("delegates to the be playback fn and returns its data on success (GET)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, {
        data: {
          playbackUrl: "https://stream.mux.com/x.m3u8?token=y",
          posterUrl: "https://sb.local/poster?token=z",
          expiresAt: "2026-08-01T00:00:00.000Z",
        },
      }),
    );

    const res = await GET(new Request("http://localhost/api/posts/p1/playback"), params("p1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      playbackUrl: "https://stream.mux.com/x.m3u8?token=y",
      posterUrl: "https://sb.local/poster?token=z",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "playback", {
      method: "POST",
      body: { postId: "p1" },
    });
  });

  it("POST without body still mints playbackUrl (media-player)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, {
        data: { playbackUrl: "https://stream.mux.com/x.m3u8?token=y", expiresAt: "2026-08-01T00:00:00.000Z" },
      }),
    );

    const res = await POST(new Request("http://localhost/api/posts/p1/playback", { method: "POST" }), params("p1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.playbackUrl).toBe("https://stream.mux.com/x.m3u8?token=y");
    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "playback", {
      method: "POST",
      body: { postId: "p1" },
    });
  });

  it("forwards posterOnly=1 on GET and returns posterUrl without requiring playbackUrl", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, {
        data: { posterUrl: "https://sb.local/poster?token=z", expiresAt: "2026-08-01T00:00:00.000Z" },
      }),
    );

    const res = await GET(
      new Request("http://localhost/api/posts/p1/playback?posterOnly=1"),
      params("p1"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      posterUrl: "https://sb.local/poster?token=z",
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    expect(body.data.playbackUrl).toBeUndefined();
    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "playback", {
      method: "POST",
      body: { postId: "p1", posterOnly: true },
    });
  });

  it("forwards posterOnly: true on POST body", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, {
        data: { posterUrl: "https://sb.local/poster?token=z", expiresAt: "2026-08-01T00:00:00.000Z" },
      }),
    );

    const res = await POST(
      new Request("http://localhost/api/posts/p1/playback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ posterOnly: true }),
      }),
      params("p1"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.posterUrl).toBe("https://sb.local/poster?token=z");
    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "playback", {
      method: "POST",
      body: { postId: "p1", posterOnly: true },
    });
  });

  it("returns 402 when the edge fn reports subscription_required (incl. posterOnly)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(fakeRes(402, {}));

    const res = await GET(
      new Request("http://localhost/api/posts/p1/playback?posterOnly=1"),
      params("p1"),
    );
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 404 not_found when the edge fn reports the post is missing", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(fakeRes(404, {}));

    const res = await GET(new Request("http://localhost/api/posts/p1/playback"), params("p1"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  // ENG-1599 — `videoIndex` on GET (query) and POST (body).
  it("forwards videoIndex on GET (query)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: { playbackUrl: "https://stream.mux.com/x.m3u8?token=y", expiresAt: "x" } }),
    );

    const res = await GET(
      new Request("http://localhost/api/posts/p1/playback?videoIndex=2"),
      params("p1"),
    );

    expect(res.status).toBe(200);
    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "playback", {
      method: "POST",
      body: { postId: "p1", videoIndex: 2 },
    });
  });

  it("forwards posterOnly=1 AND videoIndex together on GET", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: { posterUrl: "https://sb.local/poster?token=z", expiresAt: "x" } }),
    );

    const res = await GET(
      new Request("http://localhost/api/posts/p1/playback?posterOnly=1&videoIndex=1"),
      params("p1"),
    );

    expect(res.status).toBe(200);
    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "playback", {
      method: "POST",
      body: { postId: "p1", posterOnly: true, videoIndex: 1 },
    });
  });

  it("forwards videoIndex on POST body", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: { playbackUrl: "https://stream.mux.com/x.m3u8?token=y", expiresAt: "x" } }),
    );

    const res = await POST(
      new Request("http://localhost/api/posts/p1/playback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ videoIndex: 3 }),
      }),
      params("p1"),
    );

    expect(res.status).toBe(200);
    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "playback", {
      method: "POST",
      body: { postId: "p1", videoIndex: 3 },
    });
  });

  // No `videoIndex` at all — the body must carry NO `videoIndex` key, byte for
  // byte the same outbound shape every pre-ENG-1599 caller sent.
  it("omits videoIndex from the outbound body entirely when the caller sent none", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: { playbackUrl: "https://stream.mux.com/x.m3u8?token=y", expiresAt: "x" } }),
    );

    await GET(new Request("http://localhost/api/posts/p1/playback"), params("p1"));

    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "playback", {
      method: "POST",
      body: { postId: "p1" },
    });
  });

  // Every malformed GET query index → 400 invalid_video_index, edgeFetch never
  // called (validated BEFORE the mint, but AFTER the 401 check — see below).
  it.each(["5", "-1", "1.5", "abc", ""])(
    "rejects an invalid GET videoIndex=%s with 400 invalid_video_index and never calls edgeFetch",
    async (raw) => {
      getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

      const res = await GET(
        new Request(`http://localhost/api/posts/p1/playback?videoIndex=${raw}`),
        params("p1"),
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe("invalid_video_index");
      expect(edgeFetchMock).not.toHaveBeenCalled();
    },
  );

  // Same for a malformed POST body index.
  it.each([{ videoIndex: "1" }, { videoIndex: 5 }, { videoIndex: 1.5 }])(
    "rejects an invalid POST videoIndex %j with 400 invalid_video_index and never calls edgeFetch",
    async (badBody) => {
      getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

      const res = await POST(
        new Request("http://localhost/api/posts/p1/playback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(badBody),
        }),
        params("p1"),
      );
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error.code).toBe("invalid_video_index");
      expect(edgeFetchMock).not.toHaveBeenCalled();
    },
  );

  // 401 (no session) still wins over an invalid videoIndex — the auth guard
  // runs BEFORE any query/body parsing.
  it("still returns 401 (not 400) for an invalid videoIndex with no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await GET(
      new Request("http://localhost/api/posts/p1/playback?videoIndex=99"),
      params("p1"),
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  // 402 / 404 unchanged with a videoIndex present.
  it("still returns 402 when a videoIndex is present", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(fakeRes(402, {}));

    const res = await GET(
      new Request("http://localhost/api/posts/p1/playback?videoIndex=2"),
      params("p1"),
    );
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("still returns 404 when a videoIndex is present", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(fakeRes(404, {}));

    const res = await GET(
      new Request("http://localhost/api/posts/p1/playback?videoIndex=2"),
      params("p1"),
    );
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });

  it("contains no Mux signing code — the be fn is the only signer", () => {
    const source = readFileSync(
      join(__dirname, "..", "app", "api", "posts", "[id]", "playback", "route.ts"),
      "utf8",
    );

    expect(/MUX/i.test(source)).toBe(false);
  });
});
