import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal chainable Supabase query-builder stub: select/eq/order/limit return
// itself; single()/maybeSingle() resolve a per-table fixture; and the chain is
// itself awaitable (a plain `await sb.from(t).select(...).eq(...)` — no
// terminal method — resolves the same fixture), matching how the route queries
// `race_horse` directly.
const { getUserMock, fromMock, tableData } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const tableData: Record<string, { data: unknown; error?: unknown }> = {};

  function makeChain(table: string) {
    const result = () => tableData[table] ?? { data: null, error: null };
    const chain: {
      select: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      order: ReturnType<typeof vi.fn>;
      limit: ReturnType<typeof vi.fn>;
      single: ReturnType<typeof vi.fn>;
      maybeSingle: ReturnType<typeof vi.fn>;
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => unknown;
    } = {
      select: vi.fn(),
      eq: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      single: vi.fn(async () => result()),
      maybeSingle: vi.fn(async () => result()),
      then: (resolve, reject) => Promise.resolve(result()).then(resolve, reject),
    };
    chain.select.mockImplementation(() => chain);
    chain.eq.mockImplementation(() => chain);
    chain.order.mockImplementation(() => chain);
    chain.limit.mockImplementation(() => chain);
    return chain;
  }

  const fromMock = vi.fn((table: string) => makeChain(table));

  return { getUserMock, fromMock, tableData };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
  })),
}));

import { GET } from "@/app/api/horses/[id]/route";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/horses/:id", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 402 when the subscription has lapsed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "lapsed" } };

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 200 with the horse's displayName + stats (from the horse row) when a row exists", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.horse = {
      data: {
        id: "h1",
        sire: "Snitzel",
        dam: "Polar Success",
        display_name: "Snitzel x Polar Success",
        racing_name: "Mahogany",
        sex: "gelding",
        colour: "bay",
        foaling_year: new Date().getFullYear() - 5,
        training_status: "racing",
        starts: 24,
        wins: 6,
        places: 9,
        prize_money_cents: 120_000_000,
        story: "Mahogany joined Chris Waller's Rosehill stable as a yearling.",
        photo_url: "https://placehold.co/1200x400",
        trainer: { id: "t1", name: "Chris Waller", stable_name: "Chris Waller Racing", location: "Rosehill, NSW" },
      },
    };
    tableData.race_horse = { data: [] };

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.horse.displayName).toBe("Mahogany");
    expect(body.data.horse.pedigree).toBe("by Snitzel out of Polar Success");
    expect(body.data.horse.coverUrl).toBe("https://placehold.co/1200x400");
    expect(body.data.horse.about).toBe("Mahogany joined Chris Waller's Rosehill stable as a yearling.");
    expect(body.data.stats).toEqual({ starts: 24, wins: 6, places: 9, prizeMoney: "$1.2M" });
    expect(body.data.races).toEqual({ next: null, record: [] });
  });

  it("formats prize money at the k/M/plain thresholds", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.race_horse = { data: [] };

    const base = {
      id: "h1",
      sire: null,
      dam: null,
      display_name: "Unnamed",
      racing_name: null,
      sex: null,
      colour: null,
      foaling_year: null,
      training_status: "spelling",
      starts: 0,
      wins: 0,
      places: 0,
      story: null,
      photo_url: null,
      trainer: null,
    };

    tableData.horse = { data: { ...base, prize_money_cents: 45_000_00 } };
    let res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    expect((await res.json()).data.stats.prizeMoney).toBe("$45k");

    tableData.horse = { data: { ...base, prize_money_cents: 500_00 } };
    res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    expect((await res.json()).data.stats.prizeMoney).toBe("$500");
  });

  it("returns races.next + races.record, excluding scratched runners", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.horse = { data: { id: "h1", display_name: "Mahogany", racing_name: null, sire: null, dam: null, sex: null, colour: null, foaling_year: null, training_status: "racing", starts: 1, wins: 0, places: 0, prize_money_cents: 0, story: null, photo_url: null, trainer: null } };
    tableData.race_horse = {
      data: [
        // Scratched, and EARLIER than the confirmed run — must not win `next`.
        { entry_status: "scratched", barrier: 2, jockey: "J. Doe", result: null, finish_position: null,
          race: { venue: "Rosehill", race_date: "2026-07-25", race_number: 1, race_class: "BM64", distance_m: 1200, scheduled_at: "2026-07-25T06:00:00.000Z", status: "upcoming" } },
        { entry_status: "confirmed", barrier: 4, jockey: "T. Berry", result: null, finish_position: null,
          race: { venue: "Randwick", race_date: "2026-08-01", race_number: 5, race_class: "BM78", distance_m: 1400, scheduled_at: "2026-08-01T06:35:00.000Z", status: "upcoming" } },
        { entry_status: "ran", barrier: 7, jockey: "K. McEvoy", result: "2nd of 12", finish_position: 2,
          race: { venue: "Caulfield", race_date: "2026-06-04", race_number: 3, race_class: "Maiden", distance_m: 1100, scheduled_at: "2026-06-04T04:00:00.000Z", status: "finished" } },
        // Scratched completed run — excluded from the record too.
        { entry_status: "scratched", barrier: null, jockey: null, result: null, finish_position: null,
          race: { venue: "Flemington", race_date: "2026-05-01", race_number: 2, race_class: "BM70", distance_m: 1300, scheduled_at: "2026-05-01T04:00:00.000Z", status: "finished" } },
      ],
    };

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.races.next).toMatchObject({ venue: "Randwick", entry_status: "confirmed", barrier: 4, jockey: "T. Berry" });
    expect(body.data.races.record).toEqual([
      { venue: "Caulfield", race_date: "2026-06-04", race_number: 3, race_class: "Maiden", result: "2nd of 12", finish_position: 2 },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/odds|wager|bookmaker/i);
  });

  it("omits barrier + jockey for a nominated next race", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.horse = { data: { id: "h1", display_name: "Mahogany", racing_name: null, sire: null, dam: null, sex: null, colour: null, foaling_year: null, training_status: "racing", starts: 0, wins: 0, places: 0, prize_money_cents: 0, story: null, photo_url: null, trainer: null } };
    tableData.race_horse = {
      data: [
        { entry_status: "nominated", barrier: 4, jockey: "T. Berry", result: null, finish_position: null,
          race: { venue: "Randwick", race_date: "2026-08-01", race_number: 5, race_class: "BM78", distance_m: 1400, scheduled_at: "2026-08-01T06:35:00.000Z", status: "upcoming" } },
      ],
    };

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(body.data.races.next).toMatchObject({ entry_status: "nominated", barrier: null, jockey: null, distance_m: 1400 });
  });

  it("returns 404 not_found when there is no matching horse row (never 403)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.horse = { data: null };

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});
