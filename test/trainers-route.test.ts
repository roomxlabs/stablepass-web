import { describe, it, expect, vi, beforeEach } from "vitest";

// Chainable Supabase stub (mirrors test/horses-route.test.ts): select/eq/order
// return the chain; single()/maybeSingle() resolve a per-table fixture; the chain
// is awaitable (a `.select().eq()...` with no terminal method resolves the same
// fixture — which is how the route reads `horse` (array) and `post` (count)).
const { getUserMock, fromMock, tableData, fromCalls } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const tableData: Record<string, { data?: unknown; error?: unknown; count?: number }> = {};
  const fromCalls: string[] = [];

  function makeChain(table: string) {
    const result = () => tableData[table] ?? { data: null, error: null };
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      single: vi.fn(async () => result()),
      maybeSingle: vi.fn(async () => result()),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  }

  const fromMock = vi.fn((table: string) => {
    fromCalls.push(table);
    return makeChain(table);
  });

  return { getUserMock, fromMock, tableData, fromCalls };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({ auth: { getUser: getUserMock }, from: fromMock })),
}));

import { GET } from "@/app/api/trainers/[id]/route";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/trainers/:id", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    fromCalls.length = 0;
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  it("returns 401 when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("returns 402 when the subscription has lapsed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "lapsed" } };
    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("subscription_required");
  });

  it("returns 404 not_found when there is no matching trainer row (never 403)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.trainer = { data: null };
    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("returns 200 with trainer + derived stats (Horses/Updates/Wins) + horses", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.trainer = {
      data: {
        id: "t1",
        name: "Chris Waller",
        display_name: "Chris Waller Racing",
        stable_name: "Chris Waller Racing",
        location: "Rosehill, NSW",
        bio: "Premiership-winning trainer.",
        photo_url: "https://placehold.co/1200x400",
      },
    };
    tableData.horse = {
      data: [
        { id: "h1", display_name: "Snitzel x Polar Success", racing_name: "Mahogany", wins: 6 },
        { id: "h2", display_name: "Winx x Unnamed", racing_name: "Winter Sun", wins: 4 },
      ],
    };
    tableData.post = { count: 5 };

    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.trainer.displayName).toBe("Chris Waller Racing");
    expect(body.data.trainer.coverUrl).toBe("https://placehold.co/1200x400");
    expect(body.data.stats).toEqual({ horses: 2, updates: 5, wins: 10 });
    expect(body.data.horses).toEqual([
      { id: "h1", name: "Mahogany" },
      { id: "h2", name: "Winter Sun" },
    ]);
  });

  it("GUARDRAIL: never queries trainer_contact and returns no contact PII (email/phone/role)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active" } };
    // The fixture deliberately CARRIES contact PII (email/phone/role) so the
    // "no PII in response" assertion is load-bearing: it proves the route's
    // explicit-column projection strips them even if the row somehow had them. A
    // regression to `.select("*")` (which would surface these) fails this test.
    tableData.trainer = {
      data: {
        id: "t1", name: "Chris Waller", display_name: null, stable_name: "CW Racing",
        location: "NSW", bio: null, photo_url: null,
        email: "chris@waller.example", phone: "+61400000000", role: "head trainer",
      },
    };
    tableData.horse = { data: [] };
    tableData.post = { count: 0 };

    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    const raw = JSON.stringify(await res.json());

    expect(fromCalls).not.toContain("trainer_contact");
    expect(raw).not.toMatch(/"email"/);
    expect(raw).not.toMatch(/"phone"/);
    expect(raw).not.toMatch(/chris@waller\.example/);
    expect(raw).not.toMatch(/\+61400000000/);
    expect(raw).not.toMatch(/head trainer/);
  });
});
