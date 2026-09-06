import { describe, it, expect, vi, beforeEach } from "vitest";

// A chainable Supabase query-builder stub. `update`/`select`/`eq` return the
// chain itself; the chain is directly awaitable (the routes here never call a
// terminal method — they `await` the built query, or resolve via `single`-less
// `.then`). `updateMock`/`eqMock` separately record calls so tests can assert
// the exact patch and the exact self-scoping pair (mirrors me-route.test.ts's
// `updateMock` convention, plus a persistent `eq` spy per the horses-route
// "PERSISTENT chain" idiom in .rx/gotchas.md).
const { getUserMock, fromMock, tableData, updateMock, eqMock, selectMock } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const tableData: { data: unknown; error?: unknown; count?: number } = { data: null, error: null };
  const updateMock = vi.fn();
  const eqMock = vi.fn();
  const selectMock = vi.fn();

  function makeChain() {
    const result = () => tableData;
    const chain: {
      select: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => unknown;
    } = {
      select: vi.fn((...args: unknown[]) => {
        selectMock(...args);
        return chain;
      }),
      update: vi.fn((patch: unknown) => {
        updateMock(patch);
        return chain;
      }),
      eq: vi.fn((...args: unknown[]) => {
        eqMock(...args);
        return chain;
      }),
      then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  }

  const fromMock = vi.fn(() => makeChain());

  return { getUserMock, fromMock, tableData, updateMock, eqMock, selectMock };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
  })),
}));

import { PATCH } from "@/app/api/notifications/[id]/route";
import { POST as readAllPOST } from "@/app/api/notifications/read-all/route";
import { GET as unreadCountGET } from "@/app/api/notifications/unread-count/route";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function patchReq(body: unknown) {
  return new Request("http://localhost/api/notifications/n1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A well-formed notification id — GAP 2 (ENG-957 fresh-eyes review): the route
// now rejects malformed ids with a 400 BEFORE ever reaching the DB, so any test
// that expects the DB branch to run (204, .update() called, the self-scoping
// .eq('id', …) pair) needs a real uuid rather than the old "n1" placeholder.
const VALID_UUID = "11111111-1111-1111-1111-111111111111";

function rawPatchReq(body: string) {
  return new Request("http://localhost/api/notifications/n1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body,
  });
}

function reset() {
  getUserMock.mockReset();
  fromMock.mockClear();
  updateMock.mockClear();
  eqMock.mockClear();
  selectMock.mockClear();
  tableData.data = null;
  tableData.error = null;
  tableData.count = undefined;
}

describe("PATCH /api/notifications/:id", () => {
  beforeEach(reset);

  it("returns 401 when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await PATCH(patchReq({ read: true }), params("n1"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("marks the row read and returns 204", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.error = null;

    const res = await PATCH(patchReq({ read: true }), params(VALID_UUID));

    expect(res.status).toBe(204);
  });

  // mark-read flips `read`.
  it("calls .update({read:true}) — never any other patch shape", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    await PATCH(patchReq({ read: true }), params(VALID_UUID));

    expect(updateMock).toHaveBeenCalledWith({ read: true });
  });

  // ── SELF-SCOPING GUARDRAIL ────────────────────────────────────────────────
  // An id-only PATCH would let one member flip another member's row the moment
  // RLS is relaxed or bypassed. Both filters must be present.
  it("GUARDRAIL: scopes the update to BOTH .eq('id', id) AND .eq('user_id', caller's id)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    await PATCH(patchReq({ read: true }), params(VALID_UUID));

    const pairs = eqMock.mock.calls;
    expect(pairs).toContainEqual(["id", VALID_UUID]);
    expect(pairs).toContainEqual(["user_id", "user-1"]);
  });

  // ── GAP 1 (fresh-eyes review) — the `if (error) → 500` branch was dead: the
  // mock's `error` is `null` in reset() and nothing in the file ever makes it
  // truthy. Force it here so the branch genuinely executes.
  it("returns 500 write_failed when the update reports a DB error", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.error = { message: "boom" };

    const res = await PATCH(patchReq({ read: true }), params(VALID_UUID));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe("write_failed");
  });

  // ── GAP 2 (fresh-eyes review) — the route now validates the id against a
  // UUID regex BEFORE hitting the DB. A malformed id must short-circuit to a
  // 400 without ever calling .update().
  it("returns 400 validation_failed for a malformed id, and never calls .update()", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await PATCH(patchReq({ read: true }), params("not-a-uuid"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("accepts a well-formed uuid — 204, not rejected by the id regex", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await PATCH(patchReq({ read: true }), params(VALID_UUID));

    expect(res.status).toBe(204);
  });

  it("accepts an UPPERCASE uuid — the id regex is case-insensitive", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await PATCH(patchReq({ read: true }), params(VALID_UUID.toUpperCase()));

    expect(res.status).toBe(204);
  });

  it("returns 400 validation_failed for {read:false}", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await PATCH(patchReq({ read: false }), params("n1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 validation_failed for a non-object body", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await PATCH(rawPatchReq(JSON.stringify(["read", true])), params("n1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 400 validation_failed for invalid JSON", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await PATCH(rawPatchReq("not json at all"), params("n1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/notifications/read-all", () => {
  beforeEach(reset);

  it("returns 401 when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await readAllPOST();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("marks every unread row read and returns 204", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    const res = await readAllPOST();

    expect(res.status).toBe(204);
    expect(updateMock).toHaveBeenCalledWith({ read: true });
  });

  // Without the user_id filter this route marks the WHOLE TABLE read — that is
  // the point of this test, not defence in depth.
  it("GUARDRAIL: the update is scoped to .eq('user_id', caller's id) AND .eq('read', false) — omitting user_id marks the WHOLE TABLE read", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });

    await readAllPOST();

    const pairs = eqMock.mock.calls;
    expect(pairs).toContainEqual(["user_id", "user-1"]);
    expect(pairs).toContainEqual(["read", false]);
  });

  // ── GAP 1 (fresh-eyes review) — same dead branch as the PATCH route.
  it("returns 500 write_failed when the update reports a DB error", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.error = { message: "boom" };

    const res = await readAllPOST();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe("write_failed");
  });
});

describe("GET /api/notifications/unread-count", () => {
  beforeEach(reset);

  it("returns 401 when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await unreadCountGET();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns {data:{unread:N}} for a session", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.count = 7;

    const res = await unreadCountGET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ unread: 7 });
  });

  it("scopes the head:true count with .eq('user_id', caller's id) AND .eq('read', false)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.count = 0;

    await unreadCountGET();

    expect(selectMock).toHaveBeenCalledWith("id", { count: "exact", head: true });
    const pairs = eqMock.mock.calls;
    expect(pairs).toContainEqual(["user_id", "user-1"]);
    expect(pairs).toContainEqual(["read", false]);
  });

  // ── GAP 1 (fresh-eyes review) — same dead branch as the write routes above.
  it("returns 500 read_failed when the count query reports a DB error", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.error = { message: "boom" };

    const res = await unreadCountGET();
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe("read_failed");
  });
});
