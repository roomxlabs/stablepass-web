// ENG-815 — the BFF's half of "addressed by post id, never by path".
//
// `test/post-media-route.test.ts` covers the route's envelope and status codes.
// This file covers the one property that decides whether a DRAFT's slides are
// reachable, and it is deliberately kept separate so it is obvious what breaks
// it: the handler REBUILDS its outbound body from the two recognised modes
// instead of forwarding what the client sent.
//
// The edge function also ignores `path` / `paths`, so this is the second of two
// independent refusals. It is the cheap one to keep honest, and having it here
// means a change on either side alone cannot open the hole.
import { describe, it, expect, vi, beforeEach } from "vitest";

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

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/posts/media", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/posts/media — addressing (ENG-815)", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    edgeFetchMock.mockReset();
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
  });

  it("drops a `paths` key rather than forwarding it with the batch", async () => {
    edgeFetchMock.mockResolvedValue(fakeRes(200, { data: { items: [], expiresAt: "x" } }));

    await post({ postIds: ["p1"], paths: ["other-post/original"] });

    const [, , init] = edgeFetchMock.mock.calls[0];
    expect(init.body).toEqual({ postIds: ["p1"] });
    expect(Object.keys(init.body)).toEqual(["postIds"]);
  });

  it("drops a `path` key rather than forwarding it with a slide request", async () => {
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, { data: { postId: "p1", slideIndex: 2, mediaUrl: null, expiresAt: "x" } }),
    );

    await post({ postId: "p1", slideIndex: 2, path: "draft-1/photo-2", bucket: "post-media" });

    const [, , init] = edgeFetchMock.mock.calls[0];
    expect(init.body).toEqual({ postId: "p1", slideIndex: 2 });
    expect(Object.keys(init.body).sort()).toEqual(["postId", "slideIndex"]);
  });

  it("forwards a well-formed slide request and returns the envelope's data", async () => {
    edgeFetchMock.mockResolvedValue(
      fakeRes(200, {
        data: {
          postId: "p1",
          slideIndex: 1,
          mediaUrl: "https://sb.local/p1-1.jpg?token=x",
          expiresAt: "2026-08-01T00:00:00.000Z",
        },
      }),
    );

    const res = await post({ postId: "p1", slideIndex: 1 });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.mediaUrl).toBe("https://sb.local/p1-1.jpg?token=x");
    expect(edgeFetchMock).toHaveBeenCalledWith(expect.anything(), "post-media", {
      method: "POST",
      body: { postId: "p1", slideIndex: 1 },
    });
  });

  it("400s an ambiguous body carrying BOTH modes, without calling the edge fn", async () => {
    const res = await post({ postIds: ["p1"], postId: "p2", slideIndex: 0 });
    expect(res.status).toBe(400);
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("400s a body carrying NEITHER mode, without calling the edge fn", async () => {
    const res = await post({ paths: ["draft-1/photo-1"] });
    expect(res.status).toBe(400);
    expect(edgeFetchMock).not.toHaveBeenCalled();
  });

  it("calls the edge fn through edgeFetch, which sends the CALLER's token", async () => {
    // Not a service role, and not a bare fetch: `edgeFetch` attaches the
    // session's own JWT, so the mint runs under the caller's RLS and a draft's
    // objects are unreachable because Postgres refuses them. Switching this to a
    // service role would make every draft's slides mintable by any member while
    // leaving every behavioural test above green — which is precisely why the
    // call shape is pinned here.
    edgeFetchMock.mockResolvedValue(fakeRes(200, { data: { items: [], expiresAt: "x" } }));
    await post({ postIds: ["p1"] });

    expect(edgeFetchMock).toHaveBeenCalledTimes(1);
    const [client, fn, init] = edgeFetchMock.mock.calls[0];
    expect(fn).toBe("post-media");
    expect(client).toBeTruthy();
    expect(init.method).toBe("POST");
  });
});
