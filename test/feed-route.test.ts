import { describe, it, expect, vi, beforeEach } from "vitest";

const { getUserMock, singleMock, insertMock, fromMock, edgeFetchMock } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const singleMock = vi.fn();
  const insertMock = vi.fn();

  const subChain: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; single: ReturnType<typeof vi.fn> } = {
    select: vi.fn(),
    eq: vi.fn(),
    single: singleMock,
  };
  subChain.select.mockImplementation(() => subChain);
  subChain.eq.mockImplementation(() => subChain);

  const fromMock = vi.fn((table: string) => {
    if (table === "impression") return { insert: insertMock };
    return subChain;
  });

  const edgeFetchMock = vi.fn();

  return { getUserMock, singleMock, insertMock, fromMock, edgeFetchMock };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
  })),
}));

vi.mock("@/lib/api/edge", () => ({
  edgeFetch: edgeFetchMock,
}));

import { GET } from "@/app/api/feed/route";
import { POST } from "@/app/api/feed/seen/route";

function req(url: string) {
  return new Request(url);
}

function fakeRes(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe("GET /api/feed", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    singleMock.mockReset();
    insertMock.mockReset();
    edgeFetchMock.mockReset();
    fromMock.mockClear();
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await GET(req("http://localhost/api/feed"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("returns 402 when the subscription has lapsed, without calling the edge fn", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "lapsed" } });

    const res = await GET(req("http://localhost/api/feed"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("returns 200 with the edge fn's data + meta when subscribed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "trial" } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: [{ id: "p1" }], meta: { nextCursor: "c", hasMore: true } }),
    );

    const res = await GET(req("http://localhost/api/feed"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([{ id: "p1" }]);
    expect(body.meta).toEqual({ nextCursor: "c", hasMore: true });
  });

  it("returns 402 when the edge fn reports subscription_required", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "trial" } });
    edgeFetchMock.mockResolvedValue(fakeRes(402, {}));

    const res = await GET(req("http://localhost/api/feed"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 400 invalid_cursor when the edge fn rejects the cursor", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "trial" } });
    edgeFetchMock.mockResolvedValue(fakeRes(400, {}));

    const res = await GET(req("http://localhost/api/feed?cursor=bad"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("invalid_cursor");
  });
});

describe("POST /api/feed/seen", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    insertMock.mockReset();
    fromMock.mockClear();
  });

  function seenReq(body: unknown) {
    return new Request("http://localhost/api/feed/seen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("returns 401 when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await POST(seenReq({ postIds: ["p1"] }));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("inserts an impression row per postId and returns 204", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    insertMock.mockResolvedValue({ error: null });

    const res = await POST(seenReq({ postIds: ["p1", "p2"] }));

    expect(res.status).toBe(204);
    expect(fromMock).toHaveBeenCalledWith("impression");
    expect(insertMock).toHaveBeenCalledWith([
      { user_id: "user-1", post_id: "p1" },
      { user_id: "user-1", post_id: "p2" },
    ]);
  });

  it("returns 400 validation_failed when postIds is empty", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await POST(seenReq({ postIds: [] }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 400 validation_failed when postIds is not an array of strings", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await POST(seenReq({ postIds: [1, 2] }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(insertMock).not.toHaveBeenCalled();
  });
});
