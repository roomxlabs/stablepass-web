import { describe, it, expect, vi, beforeEach } from "vitest";

// A chainable Supabase query-builder stub, in the horses-route.test.ts idiom:
// select/eq/order/limit/lt return the chain itself, and the chain is also
// directly awaitable (the route never calls a terminal method for the list
// query — it just `await`s the built query). `subscription` and `notification`
// each get a PERSISTENT chain (built once, not per from() call) so their
// `select`/`eq` spies survive to be asserted on (.rx/gotchas.md).
const { getUserMock, fromMock, tableData, subChain, notifChain, subSelectMock, notifSelectMock, notifEqMock } =
  vi.hoisted(() => {
    const getUserMock = vi.fn();
    const tableData: Record<string, { data: unknown; error?: unknown }> = {};

    function makeChain(table: string) {
      const result = () => tableData[table] ?? { data: null, error: null };
      const chain: {
        select: ReturnType<typeof vi.fn>;
        eq: ReturnType<typeof vi.fn>;
        order: ReturnType<typeof vi.fn>;
        limit: ReturnType<typeof vi.fn>;
        lt: ReturnType<typeof vi.fn>;
        maybeSingle: ReturnType<typeof vi.fn>;
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => unknown;
      } = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        lt: vi.fn(),
        maybeSingle: vi.fn(async () => result()),
        then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
      };
      chain.select.mockImplementation(() => chain);
      chain.eq.mockImplementation(() => chain);
      chain.order.mockImplementation(() => chain);
      chain.limit.mockImplementation(() => chain);
      chain.lt.mockImplementation(() => chain);
      return chain;
    }

    const subChain = makeChain("subscription");
    const notifChain = makeChain("notification");
    const subSelectMock = subChain.select;
    const notifSelectMock = notifChain.select;
    const notifEqMock = notifChain.eq;

    const fromMock = vi.fn((table: string) => {
      if (table === "subscription") return subChain;
      if (table === "notification") return notifChain;
      return makeChain(table);
    });

    return { getUserMock, fromMock, tableData, subChain, notifChain, subSelectMock, notifSelectMock, notifEqMock };
  });

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
  })),
}));

import { GET } from "@/app/api/notifications/route";
import { NOTIFICATION_SELECT } from "@/app/api/notifications/contract";

function req(url: string) {
  return new Request(url);
}

function entitled() {
  getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
  tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
}

function row(over: Record<string, unknown>) {
  return {
    id: "n1",
    type: "new_post",
    target_type: "horse",
    target_id: "h1",
    title: "New post",
    body: "Something happened",
    read: false,
    created_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("GET /api/notifications", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    subSelectMock.mockClear();
    notifSelectMock.mockClear();
    notifEqMock.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await GET(req("http://localhost/api/notifications"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 402 when the subscription has lapsed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "lapsed", trial_ends_at: null, current_period_end: null } };

    const res = await GET(req("http://localhost/api/notifications"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 200 with rows mapped through toInbox for an entitled session", async () => {
    entitled();
    tableData.notification = { data: [row({})] };

    const res = await GET(req("http://localhost/api/notifications"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([
      {
        id: "n1",
        type: "new_post",
        targetType: "horse",
        targetId: "h1",
        title: "New post",
        body: "Something happened",
        read: false,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(body.meta).toEqual({ hasMore: false });
  });

  // ── SELF-SCOPING GUARDRAIL ────────────────────────────────────────────────
  // A member must never be able to read another member's rows through this
  // BFF. The query builder must carry `.eq("user_id", <the session's own id>)`
  // on the `notification` table, on top of RLS, not instead of it.
  it("GUARDRAIL: self-scopes the notification query to the caller's own user_id", async () => {
    entitled();
    tableData.notification = { data: [] };

    await GET(req("http://localhost/api/notifications"));

    const eqPairs = notifEqMock.mock.calls;
    expect(eqPairs).toContainEqual(["user_id", "user-1"]);
  });

  it("selects the explicit allow-list, never '*', and never user_id", async () => {
    entitled();
    tableData.notification = { data: [] };

    await GET(req("http://localhost/api/notifications"));

    expect(notifSelectMock).toHaveBeenCalledWith(NOTIFICATION_SELECT);
    const projection = notifSelectMock.mock.calls[0]![0] as string;
    expect(projection).not.toBe("*");
    expect(projection.split(",")).not.toContain("user_id");
  });

  it("returns 400 validation_failed for a non-ISO ?before=", async () => {
    entitled();

    const res = await GET(req("http://localhost/api/notifications?before=not-a-date"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
  });

  // ── GAP 1 (fresh-eyes review) — the `if (error) → 500` branch was dead: the
  // notification-table mock's error is never made truthy elsewhere in this file.
  it("returns 500 read_failed when the notification query reports a DB error", async () => {
    entitled();
    tableData.notification = { data: null, error: { message: "boom" } };

    const res = await GET(req("http://localhost/api/notifications"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe("read_failed");
  });

  it("returns 50 rows and meta.hasMore=true when the DB returns 51", async () => {
    entitled();
    tableData.notification = { data: Array.from({ length: 51 }, (_, i) => row({ id: `n${i}` })) };

    const res = await GET(req("http://localhost/api/notifications"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(50);
    expect(body.meta.hasMore).toBe(true);
  });
});
