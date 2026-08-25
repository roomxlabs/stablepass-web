import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// A minimal chainable Supabase query-builder stub: select/eq/order/limit return
// itself; single()/maybeSingle() resolve a per-table fixture; and the chain is
// itself awaitable (a plain `await sb.from(t).select(...).eq(...)` — no
// terminal method — resolves the same fixture), matching how the route queries
// `race_horse` directly.
const { getUserMock, fromMock, tableData, storageFromMock, createSignedUrlMock, subSelectMock, horseSelectMock } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const tableData: Record<string, { data: unknown; error?: unknown }> = {};
  // `horse-photos` is a PRIVATE bucket: the route must turn the stored object
  // path into a signed URL, never hand the raw path to the client.
  const createSignedUrlMock = vi.fn(async (path: string) => ({ data: { signedUrl: `https://sb.local/${path}?token=sig` } }));
  const storageFromMock = vi.fn(() => ({ createSignedUrl: createSignedUrlMock }));

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

  // The subscription chain is created once (not per-call, unlike the other
  // tables) so its `select` mock is a stable reference the tests can assert on.
  const subChain = makeChain("subscription");
  const subSelectMock = subChain.select;

  // Same trick for `horse` (ENG-617): the projection has to NAME the computed
  // columns `horse_age`/`horse_description`, and `sb` is untyped so `tsc` can
  // never catch a too-narrow `.select()`. A fresh chain per `from()` call would
  // hand each test a brand-new `select` spy that never saw the route's call.
  const horseChain = makeChain("horse");
  const horseSelectMock = horseChain.select;

  const fromMock = vi.fn((table: string) => {
    if (table === "subscription") return subChain;
    if (table === "horse") return horseChain;
    return makeChain(table);
  });

  return { getUserMock, fromMock, tableData, storageFromMock, createSignedUrlMock, subSelectMock, horseSelectMock };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
    storage: { from: storageFromMock },
  })),
}));

import { GET } from "@/app/api/horses/[id]/route";
import { HORSE_PROFILE_COLUMNS } from "@/lib/horse/profile";
import { GET as horseFeedGET } from "@/app/api/horses/[id]/feed/route";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/horses/:id", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    storageFromMock.mockClear();
    createSignedUrlMock.mockClear();
    subSelectMock.mockClear();
    horseSelectMock.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  it("signs a stored photo path — the raw path must never reach the client", async () => {
    // REGRESSION: admin stores a BARE OBJECT PATH in a private bucket. Returned
    // raw, the browser resolves it as a RELATIVE url and the cover silently 404s.
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
    tableData.horse = {
      data: {
        id: "h1", display_name: "Kuda Ilham", racing_name: null, sire: null, dam: null,
        sex: null, is_gelded: false, colour: null, foaling_year: null,
        horse_age: null, horse_description: null, training_status: null,
        starts: 0, wins: 0, places: 0, prize_money_cents: 0, story: null,
        photo_url: "2ab10ec3-919d-40bb-8a30-359d965751c5.jpg", trainer: null,
      },
    };
    tableData.race_horse = { data: [] };

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(storageFromMock).toHaveBeenCalledWith("horse-photos");
    expect(body.data.horse.coverUrl).toBe("https://sb.local/2ab10ec3-919d-40bb-8a30-359d965751c5.jpg?token=sig");
    expect(body.data.horse.coverUrl).not.toBe("2ab10ec3-919d-40bb-8a30-359d965751c5.jpg");
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
    tableData.subscription = { data: { status: "lapsed", trial_ends_at: null, current_period_end: null } };

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 402 when the trial has expired even though status is still trial", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2020-01-01T00:00:00Z", current_period_end: null } };

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 402 when an active member's current_period_end has passed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2020-01-01T00:00:00Z" } };

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("selects the expiry columns, not just status", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
    tableData.horse = { data: null };

    await GET(new Request("http://localhost/api/horses/h1"), params("h1"));

    expect(subSelectMock).toHaveBeenCalledWith("status,trial_ends_at,current_period_end");
  });

  it("returns 200 with the horse's displayName + stats (from the horse row) when a row exists", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
    tableData.horse = {
      data: {
        id: "h1",
        sire: "Snitzel",
        dam: "Polar Success",
        display_name: "Snitzel x Polar Success",
        racing_name: "Mahogany",
        // ENG-617: was `foaling_year: new Date().getFullYear() - 5`, which
        // returns exactly 5 under plain subtraction on ANY date and so could
        // never fail. An ABSOLUTE year, with the age the DATABASE derives.
        sex: "male",
        is_gelded: true,
        colour: "bay",
        foaling_year: 2021,
        horse_age: 5,
        horse_description: "gelding",
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
    expect(body.data.horse.ageDescription).toBe("5yo · gelding");
    expect(body.data.horse.coverUrl).toBe("https://placehold.co/1200x400");
    expect(body.data.horse.about).toBe("Mahogany joined Chris Waller's Rosehill stable as a yearling.");
    expect(body.data.stats).toEqual({ starts: 24, wins: 6, places: 9, prizeMoney: "$1.2M" });
    expect(body.data.nextRace).toBeNull();
  });

  it("formats prize money at the k/M/plain thresholds", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
    tableData.race_horse = { data: [] };

    const base = {
      id: "h1",
      sire: null,
      dam: null,
      display_name: "Unnamed",
      racing_name: null,
      sex: null,
      is_gelded: false,
      colour: null,
      foaling_year: null,
      horse_age: null,
      horse_description: null,
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

  it("returns 404 not_found when there is no matching horse row (never 403)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
    tableData.horse = { data: null };

    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});

describe("GET /api/horses/:id/feed", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    storageFromMock.mockClear();
    createSignedUrlMock.mockClear();
    subSelectMock.mockClear();
    horseSelectMock.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await horseFeedGET(new Request("http://localhost/api/horses/h1/feed"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 402 when the subscription has lapsed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "lapsed", trial_ends_at: null, current_period_end: null } };

    const res = await horseFeedGET(new Request("http://localhost/api/horses/h1/feed"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 402 when the trial has expired even though status is still trial", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2020-01-01T00:00:00Z", current_period_end: null } };

    const res = await horseFeedGET(new Request("http://localhost/api/horses/h1/feed"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 402 for an active member whose current_period_end has passed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2020-01-01T00:00:00Z" } };

    const res = await horseFeedGET(new Request("http://localhost/api/horses/h1/feed"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 200 with the horse's published posts when entitled", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
    tableData.post = { data: [{ id: "p1" }] };

    const res = await horseFeedGET(new Request("http://localhost/api/horses/h1/feed"), params("h1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([{ id: "p1" }]);
  });

  it("selects the expiry columns, not just status", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
    tableData.post = { data: [] };

    await horseFeedGET(new Request("http://localhost/api/horses/h1/feed"), params("h1"));

    expect(subSelectMock).toHaveBeenCalledWith("status,trial_ends_at,current_period_end");
  });

  // ENG-612: `sb` is untyped so `tsc` can never catch a too-narrow `.select()`;
  // this route names its post columns explicitly (unlike /api/feed, which
  // proxies the be `feed` fn's `setof post` untouched), so an omitted column
  // would silently strip the ratio.
  it("selects aspect_ratio on the post feed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
    tableData.post = { data: [] };

    await horseFeedGET(new Request("http://localhost/api/horses/h1/feed"), params("h1"));

    const postCallIndex = fromMock.mock.calls.findIndex((c) => c[0] === "post");
    expect(postCallIndex).toBeGreaterThanOrEqual(0);
    const postChain = fromMock.mock.results[postCallIndex].value as { select: ReturnType<typeof vi.fn> };
    expect(postChain.select.mock.calls[0][0]).toContain("aspect_ratio");
  });

  // ENG-772: exact equality, not `toContain`, because this projection is
  // load-bearing in BOTH directions. Too narrow is invisible to `tsc` (`sb` is
  // untyped) and silently drops a column before it reaches the card. Too wide
  // names an undeployed column and PostgREST fails the whole query with 42703
  // at runtime. Pinning the exact string is the only way to catch either.
  it("pins the EXACT post projection — it is load-bearing in both directions", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
    tableData.post = { data: [] };

    await horseFeedGET(new Request("http://localhost/api/horses/h1/feed"), params("h1"));

    const postCallIndex = fromMock.mock.calls.findIndex((c) => c[0] === "post");
    const postChain = fromMock.mock.results[postCallIndex].value as { select: ReturnType<typeof vi.fn> };
    expect(postChain.select.mock.calls[0][0]).toBe(
      "id, type, title, body, label, media_url, poster_url, mux_playback_id, aspect_ratio, watermarked, like_count, published_at, source_trainer_id",
    );
  });
});


// ─── ENG-617: the age comes from the DATABASE, not from a formula here ───────
//
// Southern-hemisphere thoroughbreds age on 1 AUGUST. The old route computed
// `new Date().getFullYear() - foaling_year`, which reads every horse a year too
// old from 1 January to 31 July — seven months of every year, live. It agreed
// with admin and mobile only because we happened to be past 1 August.
//
// The old fixture could not catch it: `foaling_year: getFullYear() - 5` returns
// exactly 5 under plain subtraction on ANY date. So these tests use ABSOLUTE
// foaling years, pin the values Postgres derives (1 August, Australia/Sydney),
// and drive a fake clock to prove the route's answer no longer depends on
// today's date at all.
describe("GET /api/horses/:id — age + description come from the database (ENG-617)", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    storageFromMock.mockClear();
    createSignedUrlMock.mockClear();
    subSelectMock.mockClear();
    horseSelectMock.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** An entitled session with no races — the 200 path. */
  function entitled() {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null } };
    tableData.race_horse = { data: [] };
  }

  /** A horse row as PostgREST returns it, computed columns included. */
  function horseRow(over: Record<string, unknown>) {
    return {
      data: {
        id: "h1",
        sire: null,
        dam: null,
        display_name: "Kuda Ilham",
        racing_name: null,
        sex: null,
        is_gelded: false,
        colour: null,
        foaling_year: null,
        horse_age: null,
        horse_description: null,
        training_status: "racing",
        starts: 0,
        wins: 0,
        places: 0,
        prize_money_cents: 0,
        story: null,
        photo_url: null,
        trainer: null,
        ...over,
      },
    };
  }

  async function get() {
    const res = await GET(new Request("http://localhost/api/horses/h1"), params("h1"));
    return { res, body: await res.json() };
  }

  // Only `Date` is faked — faking timers wholesale would stall the route's own
  // awaits. This pins "now" for the WHOLE process, so any surviving client-side
  // arithmetic would show up in the assertions below.
  function clockAt(iso: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  }

  // The full taxonomy, as H1's horse_description() derives it.
  const taxonomy = [
    { label: "a filly", age: 3, description: "filly", expected: "3yo · filly" },
    { label: "a mare", age: 4, description: "mare", expected: "4yo · mare" },
    { label: "a colt", age: 3, description: "colt", expected: "3yo · colt" },
    { label: "a horse", age: 6, description: "horse", expected: "6yo · horse" },
    { label: "a gelding", age: 9, description: "gelding", expected: "9yo · gelding" },
  ];

  for (const { label, age, description, expected } of taxonomy) {
    it(`renders ${label} as "${expected}" — straight from horse_age + horse_description`, async () => {
      entitled();
      tableData.horse = horseRow({ foaling_year: 2019, horse_age: age, horse_description: description });

      const { res, body } = await get();

      expect(res.status).toBe(200);
      expect(body.data.horse.ageDescription).toBe(expected);
    });
  }

  it("flips at the 1 AUGUST boundary — 3yo · filly on 31 July, 4yo · mare the next day", async () => {
    // One filly, foaled 2022, one absolute year. Postgres derives 3 on 31 July
    // 2026 and 4 on 1 August 2026, and her description changes with her age.
    // The OLD formula answered 2026 - 2022 = 4 on BOTH days: correct only from
    // 1 August, wrong for the seven months before it. No deploy, no code change
    // — the value moves because the database re-derives on the next read.
    entitled();

    clockAt("2026-07-31T12:00:00+10:00");
    tableData.horse = horseRow({ sex: "female", foaling_year: 2022, horse_age: 3, horse_description: "filly" });
    let result = await get();
    expect(result.res.status).toBe(200);
    expect(result.body.data.horse.ageDescription).toBe("3yo · filly");

    clockAt("2026-08-01T12:00:00+10:00");
    tableData.horse = horseRow({ sex: "female", foaling_year: 2022, horse_age: 4, horse_description: "mare" });
    result = await get();
    expect(result.res.status).toBe(200);
    expect(result.body.data.horse.ageDescription).toBe("4yo · mare");
  });

  it("does not change its answer across the New Year — the client has no opinion about dates", async () => {
    // The regression lock. Same row, same database values, midnight on New
    // Year's Eve: the age must NOT move, because 1 January is not a racing
    // birthday. The deleted formula moved it here (4yo → 5yo) and nowhere else.
    entitled();
    const row = horseRow({ sex: "female", foaling_year: 2022, horse_age: 4, horse_description: "mare" });

    // A couple of days either side of midnight, not minutes: `getFullYear()`
    // reads the HOST timezone, so instants an hour apart can still land in the
    // same calendar year on the machine running the suite and the lock would
    // pass for the wrong reason. These two are in different years everywhere.
    clockAt("2026-12-30T12:00:00Z");
    tableData.horse = row;
    const beforeNewYear = (await get()).body.data.horse.ageDescription;

    clockAt("2027-01-02T12:00:00Z");
    tableData.horse = row;
    const afterNewYear = (await get()).body.data.horse.ageDescription;

    expect(beforeNewYear).toBe("4yo · mare");
    expect(afterNewYear).toBe(beforeNewYear);
  });

  it("renders nothing for a horse with no foaling year — no `yo`, and no stray separator", async () => {
    entitled();
    tableData.horse = horseRow({ sex: "female", foaling_year: null, horse_age: null, horse_description: null });

    const { res, body } = await get();

    // Positive assertions FIRST: every negative below passes vacuously on a 402.
    expect(res.status).toBe(200);
    expect(body.data.horse.displayName).toBe("Kuda Ilham");
    expect(body.data.horse.ageDescription).toBe("");
    expect(body.data.horse.ageDescription).not.toMatch(/yo/);
    expect(body.data.horse.ageDescription).not.toMatch(/·/);
  });

  it("renders a gelding with no foaling year as `gelding` alone — no leading separator", async () => {
    entitled();
    tableData.horse = horseRow({ sex: "male", is_gelded: true, foaling_year: null, horse_age: null, horse_description: "gelding" });

    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(body.data.horse.ageDescription).toBe("gelding");
    expect(body.data.horse.ageDescription.startsWith("·")).toBe(false);
  });

  it("renders age alone when the description is unknowable (a legacy row H1 nulled)", async () => {
    entitled();
    tableData.horse = horseRow({ sex: null, foaling_year: 2021, horse_age: 5, horse_description: null });

    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(body.data.horse.ageDescription).toBe("5yo");
    expect(body.data.horse.ageDescription.endsWith("·")).toBe(false);
  });

  it("NAMES both computed columns in the projection — `sb` is untyped, so tsc can never catch a narrow select", async () => {
    entitled();
    tableData.horse = horseRow({ horse_age: 5, horse_description: "gelding" });

    await get();

    expect(horseSelectMock).toHaveBeenCalledWith(HORSE_PROFILE_COLUMNS);
    const projection = horseSelectMock.mock.calls[0]![0] as string;
    for (const column of ["horse_age", "horse_description", "foaling_year", "sex", "is_gelded"]) {
      expect(projection).toContain(column);
    }
  });

  it("pins the response key set — an `undefined` field simply vanishes from a JSON body", async () => {
    entitled();
    tableData.horse = horseRow({ horse_age: 5, horse_description: "gelding" });

    const { res, body } = await get();

    expect(res.status).toBe(200);
    expect(Object.keys(body.data).sort()).toEqual(["horse", "nextRace", "stats", "trainer"]);
    expect(Object.keys(body.data.horse).sort()).toEqual([
      "about",
      "ageDescription",
      "coverUrl",
      "displayName",
      "id",
      "pedigree",
      "trainingStatus",
    ]);
  });

  it("GUARDRAIL: a lapsed session still gets 402 — and no horse, no age, no description", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    tableData.subscription = { data: { status: "lapsed", trial_ends_at: null, current_period_end: null } };
    // Seeded on purpose: if the gate ever leaked, these values would be in the body.
    tableData.horse = horseRow({ sex: "male", is_gelded: true, foaling_year: 2021, horse_age: 5, horse_description: "gelding" });

    const { res, body } = await get();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
    expect(body.data).toBeUndefined();
    // The gate runs BEFORE the horse read — the row is never even fetched.
    expect(horseSelectMock).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("5yo");
    expect(JSON.stringify(body)).not.toContain("gelding");
  });

  it("GUARDRAIL: hidden content is 404 for an entitled member, never 403", async () => {
    entitled();
    tableData.horse = { data: null };

    const { res, body } = await get();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("not_found");
    expect(body.data).toBeUndefined();
  });
});
