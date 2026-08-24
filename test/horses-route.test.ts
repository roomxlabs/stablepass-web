import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal chainable Supabase query-builder stub: select/eq/order/limit return
// itself; single()/maybeSingle() resolve a per-table fixture; and the chain is
// itself awaitable (a plain `await sb.from(t).select(...).eq(...)` — no
// terminal method — resolves the same fixture), matching how the route queries
// `race_horse` directly.
const { getUserMock, fromMock, tableData, storageFromMock, createSignedUrlMock, subSelectMock } = vi.hoisted(() => {
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

  const fromMock = vi.fn((table: string) => (table === "subscription" ? subChain : makeChain(table)));

  return { getUserMock, fromMock, tableData, storageFromMock, createSignedUrlMock, subSelectMock };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
    storage: { from: storageFromMock },
  })),
}));

import { GET } from "@/app/api/horses/[id]/route";
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
        sex: null, colour: null, foaling_year: null, training_status: null,
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
