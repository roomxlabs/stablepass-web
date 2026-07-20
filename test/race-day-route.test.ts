// GET /api/race-day (RF5, ENG-297) — the Explore "Racing today" band's BFF read.
// Same chainable Supabase stub as test/horses-route.test.ts, extended with the
// `in()` / `not()` filters this route uses.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getUserMock, fromMock, tableData } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const tableData: Record<string, { data: unknown; error?: unknown }> = {};

  function makeChain(table: string) {
    const result = () => tableData[table] ?? { data: null, error: null };
    const chain: Record<string, unknown> = {
      single: vi.fn(async () => result()),
      maybeSingle: vi.fn(async () => result()),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    for (const m of ["select", "eq", "in", "not", "order", "limit"]) {
      chain[m] = vi.fn(() => chain);
    }
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

import { GET } from "@/app/api/race-day/route";

/** race.race_date is a DATE — the route compares against the local calendar day. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const raceAt = (hourOffset: number, raceDate = todayLocal()) => ({
  venue: "Randwick",
  race_date: raceDate,
  race_number: 5,
  race_class: "BM78",
  distance_m: 1400,
  scheduled_at: new Date(Date.now() + hourOffset * 3_600_000).toISOString(),
});

describe("GET /api/race-day", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 402 when the subscription has lapsed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "lapsed" } };

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns an empty array when the viewer follows no horses (band hides)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.follow = { data: [] };

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.races).toEqual([]);
    // Short-circuits before touching race_horse at all.
    expect(fromMock).not.toHaveBeenCalledWith("race_horse");
  });

  it("returns today's runners for followed horses, earliest first, with the bell flag", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "active" } };
    tableData.follow = { data: [{ horse_id: "h1" }, { horse_id: "h2" }] };
    tableData.notify_optin = { data: [{ horse_id: "h1" }] };
    tableData.race_horse = {
      data: [
        { horse: { id: "h2", display_name: "Northern Star" }, race: raceAt(6) },
        { horse: { id: "h1", display_name: "Mahogany" }, race: raceAt(3) },
      ],
    };

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.races).toHaveLength(2);
    expect(body.data.races.map((r: { horseName: string }) => r.horseName)).toEqual(["Mahogany", "Northern Star"]);
    expect(body.data.races[0]).toMatchObject({
      horseId: "h1",
      horseName: "Mahogany",
      info: "Randwick R5 · BM78 · 1400m",
      notify: true,
    });
    expect(body.data.races[1].notify).toBe(false);
    // Internal sort key must not leak into the payload.
    expect(body.data.races[0]).not.toHaveProperty("scheduledAt");
  });

  it("excludes runners whose race is not today", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.follow = { data: [{ horse_id: "h1" }] };
    tableData.notify_optin = { data: [] };
    tableData.race_horse = {
      data: [{ horse: { id: "h1", display_name: "Mahogany" }, race: raceAt(30, "2026-12-25") }],
    };

    const res = await GET();
    expect((await res.json()).data.races).toEqual([]);
  });

  it("asks the database for confirmed runners scoped to the followed horses only", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.follow = { data: [{ horse_id: "h1" }] };
    tableData.notify_optin = { data: [] };
    tableData.race_horse = { data: [] };

    await GET();

    // The lifecycle + follow scoping are enforced in the query, not post-hoc:
    // nominated/scratched/not_accepted never leave the database for this band.
    const raceHorseChain = fromMock.mock.results[fromMock.mock.calls.findIndex(([t]) => t === "race_horse")]
      .value as { eq: ReturnType<typeof vi.fn>; in: ReturnType<typeof vi.fn>; select: ReturnType<typeof vi.fn> };
    expect(raceHorseChain.eq).toHaveBeenCalledWith("entry_status", "confirmed");
    expect(raceHorseChain.in).toHaveBeenCalledWith("horse_id", ["h1"]);
  });

  it("never selects an odds/betting or owner field (guardrail)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial" } };
    tableData.follow = { data: [{ horse_id: "h1" }] };
    tableData.notify_optin = { data: [] };
    tableData.race_horse = { data: [] };

    await GET();

    const selects = fromMock.mock.results
      .flatMap((r) => (r.value as { select: { mock: { calls: unknown[][] } } }).select.mock.calls)
      .flat()
      .join(" ");
    expect(selects).not.toMatch(/odds|bet|wager|bookmaker|owner/i);
    // And the admin-only match-proposal table is never touched by a member read.
    expect(fromMock).not.toHaveBeenCalledWith("horse_match_proposal");
  });
});
