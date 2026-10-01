import { describe, it, expect, vi, beforeEach } from "vitest";

// Chainable Supabase stub (mirrors test/horses-route.test.ts): select/eq/order
// return the chain; single()/maybeSingle() resolve a per-table fixture; the chain
// is awaitable (a `.select().eq()...` with no terminal method resolves the same
// fixture — which is how the route reads `horse` (array) and `post` (count)).
const { getUserMock, fromMock, tableData, fromCalls, storageFromMock, createSignedUrlMock, subSelectMock } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const tableData: Record<string, { data?: unknown; error?: unknown; count?: number }> = {};
  const fromCalls: string[] = [];
  // `trainer-photos` is a PRIVATE bucket: the route must turn the stored object
  // path into a signed URL, never hand the raw path to the client.
  const createSignedUrlMock = vi.fn(async (path: string) => ({ data: { signedUrl: `https://sb.local/${path}?token=sig` } }));
  const storageFromMock = vi.fn(() => ({ createSignedUrl: createSignedUrlMock }));

  function makeChain(table: string) {
    const result = () => tableData[table] ?? { data: null, error: null };
    const chain: Record<string, unknown> = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      lt: vi.fn(() => chain),
      or: vi.fn(() => chain),
      order: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      single: vi.fn(async () => result()),
      maybeSingle: vi.fn(async () => result()),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve, reject),
    };
    return chain;
  }

  // The subscription chain is created once (not per-call, unlike the other
  // tables) so its `select` mock is a stable reference the tests can assert on.
  const subChain = makeChain("subscription");
  const subSelectMock = subChain.select as ReturnType<typeof vi.fn>;

  const fromMock = vi.fn((table: string) => {
    fromCalls.push(table);
    return table === "subscription" ? subChain : makeChain(table);
  });

  return { getUserMock, fromMock, tableData, fromCalls, storageFromMock, createSignedUrlMock, subSelectMock };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
    storage: { from: storageFromMock },
  })),
}));

import { GET } from "@/app/api/trainers/[id]/route";
import { GET as trainerFeedGET } from "@/app/api/trainers/[id]/feed/route";
import { parseProfileCursor, profileCursorFilter } from "@/lib/feed/profile-cursor";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/trainers/:id", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    fromCalls.length = 0;
    storageFromMock.mockClear();
    createSignedUrlMock.mockClear();
    subSelectMock.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  it("signs a stored photo path — the raw path must never reach the client", async () => {
    // REGRESSION: admin stores a BARE OBJECT PATH (e.g. "ilham-1785164320876.jpg")
    // in a private bucket. Returning it raw makes the browser resolve it as a
    // RELATIVE url (/trainers/<id>/ilham-....jpg) and the image silently 404s.
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" } };
    tableData.trainer = {
      data: {
        id: "t1", name: "Ilham", display_name: null, stable_name: null,
        location: null, bio: null, photo_url: "ilham-1785164320876.jpg",
      },
    };
    tableData.horse = { data: [] };
    tableData.post = { count: 0 };

    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    const body = await res.json();

    expect(storageFromMock).toHaveBeenCalledWith("trainer-photos");
    expect(body.data.trainer.coverUrl).toBe("https://sb.local/ilham-1785164320876.jpg?token=sig");
    expect(body.data.trainer.coverUrl).not.toBe("ilham-1785164320876.jpg");
  });

  it("returns 401 when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });
    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("returns 402 when the subscription has lapsed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "lapsed", trial_ends_at: null, current_period_end: null } };
    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("subscription_required");
  });

  it("returns 402 when the paid period has expired even though status is still active", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2020-01-01T00:00:00Z" } };
    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("subscription_required");
  });

  it("returns 402 when an active member's current_period_end has passed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2020-01-01T00:00:00Z" } };
    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("subscription_required");
  });

  it("selects the expiry columns, not just status", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" } };
    tableData.trainer = { data: null };
    await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    expect(subSelectMock).toHaveBeenCalledWith("status,trial_ends_at,current_period_end");
  });

  it("returns 404 not_found when there is no matching trainer row (never 403)", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" } };
    tableData.trainer = { data: null };
    const res = await GET(new Request("http://localhost/api/trainers/t1"), params("t1"));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("returns 200 with trainer + derived stats (Horses/Updates/Wins) + horses", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" } };
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
    // Entitled via an explicit FUTURE period end, not the `current_period_end:
    // null` special case — this guardrail must not ride on the branch most
    // likely to be revisited by a future "tighten the gate" ticket.
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" } };
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

    // Load-bearing: every assertion below is a NEGATIVE, so without pinning a
    // 200 (and a field we DO expect) this whole guardrail passes vacuously
    // against a 402 `subscription_required` envelope.
    expect(res.status).toBe(200);
    expect(raw).toMatch(/Chris Waller/);
    expect(fromCalls).not.toContain("trainer_contact");
    expect(raw).not.toMatch(/"email"/);
    expect(raw).not.toMatch(/"phone"/);
    expect(raw).not.toMatch(/chris@waller\.example/);
    expect(raw).not.toMatch(/\+61400000000/);
    expect(raw).not.toMatch(/head trainer/);
  });
});

describe("GET /api/trainers/:id/feed", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    fromCalls.length = 0;
    storageFromMock.mockClear();
    createSignedUrlMock.mockClear();
    subSelectMock.mockClear();
    for (const key of Object.keys(tableData)) delete tableData[key];
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await trainerFeedGET(new Request("http://localhost/api/trainers/t1/feed"), params("t1"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 402 when the subscription has lapsed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "lapsed", trial_ends_at: null, current_period_end: null } };

    const res = await trainerFeedGET(new Request("http://localhost/api/trainers/t1/feed"), params("t1"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 402 when the paid period has expired even though status is still active", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2020-01-01T00:00:00Z" } };

    const res = await trainerFeedGET(new Request("http://localhost/api/trainers/t1/feed"), params("t1"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 402 for an active member whose current_period_end has passed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2020-01-01T00:00:00Z" } };

    const res = await trainerFeedGET(new Request("http://localhost/api/trainers/t1/feed"), params("t1"));
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error.code).toBe("subscription_required");
  });

  it("returns 200 with the trainer's published posts when entitled", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" } };
    tableData.post = { data: [{ id: "p1" }] };

    const res = await trainerFeedGET(new Request("http://localhost/api/trainers/t1/feed"), params("t1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([{ id: "p1" }]);
  });

  it("selects the expiry columns, not just status", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" } };
    tableData.post = { data: [] };

    await trainerFeedGET(new Request("http://localhost/api/trainers/t1/feed"), params("t1"));

    expect(subSelectMock).toHaveBeenCalledWith("status,trial_ends_at,current_period_end");
  });

  // ENG-612: `sb` is untyped so `tsc` can never catch a too-narrow `.select()`;
  // this route names its post columns explicitly (unlike /api/feed, which
  // proxies the be `feed` fn's `setof post` untouched), so an omitted column
  // would silently strip the ratio.
  it("selects aspect_ratio on the post feed", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" } };
    tableData.post = { data: [] };

    await trainerFeedGET(new Request("http://localhost/api/trainers/t1/feed"), params("t1"));

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
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" } };
    tableData.post = { data: [] };

    await trainerFeedGET(new Request("http://localhost/api/trainers/t1/feed"), params("t1"));

    const postCallIndex = fromMock.mock.calls.findIndex((c) => c[0] === "post");
    const postChain = fromMock.mock.results[postCallIndex].value as { select: ReturnType<typeof vi.fn> };
    // ENG-1270: `POST_INTRINSIC_COLUMNS` widened by four (`subject`, `byline`,
    // `horse_id`, `source_trainer_id`); the old per-route `, horse_id` was
    // removed from this route's own `.select()` at the same time, since the
    // constant now carries it — see lib/feed/post-row.ts and this route's own
    // comment. Updated here deliberately: this is the ticket's own change.
    expect(postChain.select.mock.calls[0][0]).toBe(
      "id, type, title, body, label, media_url, poster_url, mux_playback_id, aspect_ratio, watermarked, like_count, published_at, subject, byline, horse_id, source_trainer_id, horse:horse_id(display_name, racing_name, photo_url)",
    );
  });
  // ENG-1633 — `?cursor=` paging. The cursor is a `<published_at>|<id>` keyset.
  describe("ENG-1633 paging", () => {
    const entitled = () => {
      getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
      tableData.subscription = { data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" } };
    };
    const postChain = () => {
      const i = fromMock.mock.calls.findIndex((c) => c[0] === "post");
      return i < 0 ? null : (fromMock.mock.results[i].value as { lt: ReturnType<typeof vi.fn>; or: ReturnType<typeof vi.fn>; order: ReturnType<typeof vi.fn>; limit: ReturnType<typeof vi.fn> });
    };
    const rows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: uuid(i), published_at: `2026-07-${String(30 - i).padStart(2, "0")}T00:00:00.000Z` }));
    const uuid = (i: number) => `00000000-0000-4000-8000-${String(1000 - i).padStart(12, "0")}`;
    const TS = "2026-07-10T00:00:00.000Z";
    const feed = (qs = "") => trainerFeedGET(new Request(`http://localhost/api/trainers/t1/feed${qs}`), params("t1"));

    it("a malformed cursor is 400 invalid_cursor, and never reaches a post query", async () => {
      entitled();
      tableData.post = { data: [] };
      const res = await feed("?cursor=not-a-date");
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_cursor");
      expect(postChain()).toBeNull();
    });

    it("the gate comes FIRST: a lapsed member with a malformed cursor still gets 402", async () => {
      getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
      tableData.subscription = { data: { status: "lapsed", trial_ends_at: null, current_period_end: null } };
      const res = await feed("?cursor=not-a-date");
      expect(res.status).toBe(402);
      expect((await res.json()).error.code).toBe("subscription_required");
    });

    it("no session with a malformed cursor is still 401", async () => {
      getUserMock.mockResolvedValue({ data: { user: null } });
      expect((await feed("?cursor=zzz")).status).toBe(401);
    });

    it.each([
      ["a bare timestamp (no id half)", TS],
      ["a non-UUID id half", `${TS}|p19`],
      ["three parts", `${TS}|${"00000000-0000-4000-8000-000000000001"}|x`],
      ["an .or() injection in the id half", `${TS}|00000000-0000-4000-8000-000000000001),id.gt.(0`],
      ["an .or() injection in the timestamp half", `${TS},id.gt.0|00000000-0000-4000-8000-000000000001`],
      ["a quote in the id half", `${TS}|"00000000-0000-4000-8000-000000000001"`],
    ])("rejects %s with 400, before any post query", async (_label, cursor) => {
      entitled();
      tableData.post = { data: [] };
      const res = await feed(`?cursor=${encodeURIComponent(cursor)}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("invalid_cursor");
      expect(postChain()).toBeNull();
    });

    it("a valid cursor filters on the (published_at, id) keyset, ordered published_at desc, id desc", async () => {
      entitled();
      tableData.post = { data: [] };
      const id = uuid(19);
      await feed(`?cursor=${encodeURIComponent(`${TS}|${id}`)}`);
      const chain = postChain()!;
      expect(chain.lt).not.toHaveBeenCalled();
      expect(chain.or).toHaveBeenCalledWith(`published_at.lt."${TS}",and(published_at.eq."${TS}",id.lt."${id}")`);
      expect(chain.order.mock.calls).toEqual([
        ["published_at", { ascending: false }],
        ["id", { ascending: false }],
      ]);
    });

    it("same-timestamp boundary: 25 posts sharing one published_at page as 20 + 5 with none skipped", async () => {
      entitled();
      // All 25 share `now()` (a bulk publish), ids descending as the DB orders them.
      const all = Array.from({ length: 25 }, (_, i) => ({ id: uuid(i), published_at: TS }));
      tableData.post = { data: all.slice(0, 20) };
      const page1 = await (await feed()).json();
      expect(page1.meta).toEqual({ hasMore: true, nextCursor: `${TS}|${uuid(19)}` });

      // Apply the keyset the route sends to the full set — what the DB does.
      const c = parseProfileCursor(page1.meta.nextCursor)!;
      const rest = all.filter((r) => r.published_at < c.publishedAt || (r.published_at === c.publishedAt && r.id < c.id));
      expect(rest.map((r) => r.id)).toEqual(all.slice(20).map((r) => r.id));
      // A bare `published_at < c` (the old cursor) would have skipped all five.
      expect(all.filter((r) => r.published_at < c.publishedAt)).toHaveLength(0);

      fromMock.mockClear();
      tableData.post = { data: rest };
      const page2 = await (await feed(`?cursor=${encodeURIComponent(page1.meta.nextCursor)}`)).json();
      expect(postChain()!.or).toHaveBeenCalledWith(profileCursorFilter(c));
      expect(page2.data).toHaveLength(5);
      expect(page2.meta).toEqual({ hasMore: false, nextCursor: null });
    });

    it("page 1 (no cursor) applies no cursor filter", async () => {
      entitled();
      tableData.post = { data: [] };
      await feed();
      expect(postChain()!.lt).not.toHaveBeenCalled();
      expect(postChain()!.or).not.toHaveBeenCalled();
      expect(postChain()!.limit).toHaveBeenCalledWith(20);
    });

    it("a full page of 20 -> meta { hasMore: true, nextCursor: <last published_at>|<last id> }", async () => {
      entitled();
      const page = rows(20);
      tableData.post = { data: page };
      const body = await (await feed()).json();
      expect(body.data).toHaveLength(20);
      expect(body.meta).toEqual({ hasMore: true, nextCursor: `${page[19].published_at}|${page[19].id}` });
    });

    it("fewer than 20 rows -> meta { hasMore: false, nextCursor: null }", async () => {
      entitled();
      tableData.post = { data: rows(19) };
      const body = await (await feed()).json();
      expect(body.meta).toEqual({ hasMore: false, nextCursor: null });
    });

    it("a REJECTED post read is a 500 feed_failed, never an empty page that ends the list", async () => {
      entitled();
      tableData.post = { data: null, error: { code: "PGRST100", message: "failed to parse logic tree" } };
      const res = await feed(`?cursor=${encodeURIComponent(`${TS}|${uuid(19)}`)}`);
      expect(res.status).toBe(500);
      expect((await res.json()).error.code).toBe("feed_failed");
    });

    it("an empty page -> meta { hasMore: false, nextCursor: null }", async () => {
      entitled();
      tableData.post = { data: [] };
      const body = await (await feed()).json();
      expect(body.meta).toEqual({ hasMore: false, nextCursor: null });
    });
  });
});
