import { describe, it, expect, vi, beforeEach } from "vitest";

// Mirrors test/trainers-route.test.ts's chainable Supabase stub, plus an
// `insert` recorder so we can assert exactly what row the route writes.
const { getUserMock, fromMock, insertCalls, fromCalls } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const insertCalls: Array<{ table: string; row: unknown }> = [];
  const fromCalls: string[] = [];

  const fromMock = vi.fn((table: string) => {
    fromCalls.push(table);
    const chain: Record<string, unknown> = {
      insert: vi.fn(async (row: unknown) => {
        insertCalls.push({ table, row });
        return { data: null, error: null };
      }),
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      single: vi.fn(async () => ({ data: null, error: null })),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    };
    return chain;
  });

  return { getUserMock, fromMock, insertCalls, fromCalls };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({ auth: { getUser: getUserMock }, from: fromMock })),
}));

import { POST } from "@/app/api/trainers/[id]/website-click/route";

const TRAINER_ID = "3f1c9b2e-5a4d-4c8b-9e7a-1d2b3c4d5e6f";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}
function req() {
  return new Request("http://localhost/api/trainers/x/website-click", { method: "POST" });
}

describe("POST /api/trainers/:id/website-click", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    insertCalls.length = 0;
    fromCalls.length = 0;
  });

  it("returns 401 when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await POST(req(), params(TRAINER_ID));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
    // Nothing is written for an unauthenticated caller.
    expect(insertCalls).toHaveLength(0);
  });

  it("returns 400 for a malformed (non-uuid) trainer id", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    const res = await POST(req(), params("not-a-uuid"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
    expect(insertCalls).toHaveLength(0);
  });

  it("returns 204 with no body and inserts the click row for a signed-in member", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    const res = await POST(req(), params(TRAINER_ID));

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(insertCalls).toEqual([
      { table: "trainer_website_click", row: { trainer_id: TRAINER_ID, user_id: "u1" } },
    ]);
  });

  it("GUARDRAIL: user_id comes from the session, never from the request body", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "real-user" } } });
    // A hostile client tries to attribute the click to somebody else.
    const hostile = new Request("http://localhost/api/trainers/x/website-click", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: "victim-user", trainer_id: "some-other-trainer" }),
    });

    const res = await POST(hostile, params(TRAINER_ID));

    expect(res.status).toBe(204);
    const row = insertCalls[0].row as Record<string, unknown>;
    expect(row.user_id).toBe("real-user");
    expect(row.trainer_id).toBe(TRAINER_ID);
  });

  // Note: supabaseServer is mocked here, so this pins the TABLE only — it cannot
  // prove which client was used. That the caller's RLS client is used is proven by
  // the static import in the route plus the live RLS policy
  // (user_id = auth.uid() AND has_content_access(auth.uid())), exercised end-to-end
  // by the A2 Playwright test against real Supabase.
  it("GUARDRAIL: writes only to the trainer_website_click table", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    await POST(req(), params(TRAINER_ID));
    expect(fromCalls).toEqual(["trainer_website_click"]);
  });
});
