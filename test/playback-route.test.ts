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

import { GET } from "@/app/api/posts/[id]/playback/route";

function fakeRes(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/posts/:id/playback", () => {
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

  it("delegates to the be playback fn and returns its data on success", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: { playbackUrl: "https://stream.mux.com/x.m3u8?token=y", expiresAt: "2026-08-01T00:00:00.000Z" } }),
    );

    const res = await GET(new Request("http://localhost/api/posts/p1/playback"), params("p1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ playbackUrl: "https://stream.mux.com/x.m3u8?token=y", expiresAt: "2026-08-01T00:00:00.000Z" });
    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "playback", { method: "POST", body: { postId: "p1" } });
  });

  it("returns 402 when the edge fn reports subscription_required", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(fakeRes(402, {}));

    const res = await GET(new Request("http://localhost/api/posts/p1/playback"), params("p1"));
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

  it("contains no Mux signing code — the be fn is the only signer", () => {
    const source = readFileSync(
      join(__dirname, "..", "app", "api", "posts", "[id]", "playback", "route.ts"),
      "utf8",
    );

    expect(/MUX/i.test(source)).toBe(false);
  });
});
