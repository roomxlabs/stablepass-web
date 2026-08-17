import { describe, it, expect, vi, beforeEach } from "vitest";

const { getUserMock, singleMock, insertMock, fromMock, edgeFetchMock, subSelectMock } = vi.hoisted(() => {
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
  const subSelectMock = subChain.select;

  return { getUserMock, singleMock, insertMock, fromMock, edgeFetchMock, subSelectMock };
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
import { GET as followingGET } from "@/app/api/feed/following/route";

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
    subSelectMock.mockClear();
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
    singleMock.mockResolvedValue({ data: { status: "lapsed", trial_ends_at: null, current_period_end: null } });

    const res = await GET(req("http://localhost/api/feed"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("returns 200 with the edge fn's data + meta when subscribed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } });
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
    singleMock.mockResolvedValue({ data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } });
    edgeFetchMock.mockResolvedValue(fakeRes(402, {}));

    const res = await GET(req("http://localhost/api/feed"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 400 invalid_cursor when the edge fn rejects the cursor", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } });
    edgeFetchMock.mockResolvedValue(fakeRes(400, {}));

    const res = await GET(req("http://localhost/api/feed?cursor=bad"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("invalid_cursor");
  });

  it("returns 402 when the trial expired even though status is still trial", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "trial", trial_ends_at: "2020-01-01T00:00:00Z", current_period_end: null } });

    const res = await GET(req("http://localhost/api/feed"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("returns 200 for an active member whose current_period_end is null", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "active", trial_ends_at: null, current_period_end: null } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: [{ id: "p1" }], meta: { nextCursor: null, hasMore: false } }),
    );

    const res = await GET(req("http://localhost/api/feed"));

    expect(res.status).toBe(200);
  });

  it("returns 402 for an active member whose current_period_end has passed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "active", trial_ends_at: null, current_period_end: "2020-01-01T00:00:00Z" } });

    const res = await GET(req("http://localhost/api/feed"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("selects the expiry columns, not just status", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: [{ id: "p1" }], meta: { nextCursor: null, hasMore: false } }),
    );

    await GET(req("http://localhost/api/feed"));

    expect(subSelectMock).toHaveBeenCalledWith("status,trial_ends_at,current_period_end");
  });
});

describe("GET /api/feed/following", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    singleMock.mockReset();
    insertMock.mockReset();
    edgeFetchMock.mockReset();
    fromMock.mockClear();
    subSelectMock.mockClear();
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await followingGET(req("http://localhost/api/feed/following"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("returns 402 when the subscription has lapsed, without calling the edge fn", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "lapsed", trial_ends_at: null, current_period_end: null } });

    const res = await followingGET(req("http://localhost/api/feed/following"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("returns 402 when the trial expired even though status is still trial", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "trial", trial_ends_at: "2020-01-01T00:00:00Z", current_period_end: null } });

    const res = await followingGET(req("http://localhost/api/feed/following"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("returns 402 for an active member whose current_period_end has passed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "active", trial_ends_at: null, current_period_end: "2020-01-01T00:00:00Z" } });

    const res = await followingGET(req("http://localhost/api/feed/following"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("returns 200 for an active member whose current_period_end is null", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "active", trial_ends_at: null, current_period_end: null } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: [{ id: "p1" }], meta: { nextCursor: null, hasMore: false } }),
    );

    const res = await followingGET(req("http://localhost/api/feed/following"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([{ id: "p1" }]);
  });

  it("selects the expiry columns, not just status", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    singleMock.mockResolvedValue({ data: { status: "active", trial_ends_at: null, current_period_end: null } });
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: [{ id: "p1" }], meta: { nextCursor: null, hasMore: false } }),
    );

    await followingGET(req("http://localhost/api/feed/following"));

    expect(subSelectMock).toHaveBeenCalledWith("status,trial_ends_at,current_period_end");
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
