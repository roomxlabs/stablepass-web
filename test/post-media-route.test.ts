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

import { POST } from "@/app/api/posts/media/route";

function fakeRes(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe("POST /api/posts/media", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    edgeFetchMock.mockReset();
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await POST(
      new Request("http://localhost/api/posts/media", {
        method: "POST",
        body: JSON.stringify({ postIds: ["p1"] }),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("forwards { postIds } to edgeFetch and returns its data on success", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, {
        data: {
          items: [{ postId: "p1", mediaUrl: "https://sb.local/signed?token=x" }],
          expiresAt: "2026-08-01T00:00:00.000Z",
        },
      }),
    );

    const res = await POST(
      new Request("http://localhost/api/posts/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postIds: ["p1", "p2"] }),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      items: [{ postId: "p1", mediaUrl: "https://sb.local/signed?token=x" }],
      expiresAt: "2026-08-01T00:00:00.000Z",
    });
    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "post-media", {
      method: "POST",
      body: { postIds: ["p1", "p2"] },
    });
    // Never a path or a service key in the edge body.
    const edgeBody = edgeFetchMock.mock.calls[0][2].body as { postIds: string[] };
    expect(edgeBody).toEqual({ postIds: ["p1", "p2"] });
    expect(JSON.stringify(edgeBody)).not.toMatch(/path|SERVICE_ROLE|service.?key/i);
  });

  it("returns 402 when the edge fn reports subscription_required", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(fakeRes(402, {}));

    const res = await POST(
      new Request("http://localhost/api/posts/media", {
        method: "POST",
        body: JSON.stringify({ postIds: ["p1"] }),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 400 invalid_request when the edge fn reports 400", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(fakeRes(400, {}));

    const res = await POST(
      new Request("http://localhost/api/posts/media", {
        method: "POST",
        body: JSON.stringify({ postIds: [] }),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
  });

  it("returns 502 post_media_failed when the edge fn returns 500", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    edgeFetchMock.mockResolvedValue(fakeRes(500, {}));

    const res = await POST(
      new Request("http://localhost/api/posts/media", {
        method: "POST",
        body: JSON.stringify({ postIds: ["p1"] }),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("post_media_failed");
  });

  it("never holds a service key — route source has no SERVICE_ROLE", () => {
    const source = readFileSync(
      join(__dirname, "..", "app", "api", "posts", "media", "route.ts"),
      "utf8",
    );
    expect(/SERVICE_ROLE|service.?role|createSignedUrl/i.test(source)).toBe(false);
  });
});
