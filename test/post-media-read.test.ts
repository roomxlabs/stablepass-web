// ENG-762 — the `post_media` read (lib/post-media.ts).
//
// This is the file the ticket's guardrail line points at: "column tests for the
// new select (house gotcha)". `sb` is untyped, so `tsc` proves nothing about the
// projection, and BOTH directions of getting it wrong fail SILENTLY — too narrow
// starves the carousel, too wide returns `{data: null, error}` that reads back as
// "no photos". So the exact string is asserted with `.toBe`, not `.toContain`.
import { describe, it, expect } from "vitest";
import { readPostPhotos, POST_MEDIA_COLUMNS } from "@/lib/post-media";

type Row = { post_id: string; sort_order: number; media_url: string | null };

/**
 * A fake PostgREST/Storage client that records what it was asked for. Built by
 * hand rather than mocked module-wide so the assertions below are about the
 * REAL `readPostPhotos` body — the mutation check at the bottom of this file
 * depends on that being true.
 */
function fakeSb(opts: {
  rows?: Row[];
  error?: unknown;
  signed?: Record<string, string>;
  signedData?: unknown;
}) {
  const calls = {
    from: [] as string[],
    select: [] as string[],
    in: [] as Array<[string, readonly string[]]>,
    order: [] as Array<[string, unknown]>,
    storageFrom: [] as string[],
    createSignedUrls: [] as Array<[string[], number]>,
  };

  const builder: Record<string, unknown> = {};
  builder.select = (cols: string) => {
    calls.select.push(cols);
    return builder;
  };
  builder.in = (col: string, vals: readonly string[]) => {
    calls.in.push([col, vals]);
    return builder;
  };
  builder.order = (col: string, cfg: unknown) => {
    calls.order.push([col, cfg]);
    return builder;
  };
  // The builder resolves like a PostgREST query when awaited.
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: opts.error ? null : opts.rows ?? [], error: opts.error ?? null }).then(resolve);

  const sb = {
    from: (table: string) => {
      calls.from.push(table);
      return builder;
    },
    storage: {
      from: (bucket: string) => {
        calls.storageFrom.push(bucket);
        return {
          createSignedUrls: async (paths: string[], ttl: number) => {
            calls.createSignedUrls.push([paths, ttl]);
            if (opts.signedData !== undefined) return { data: opts.signedData };
            return {
              data: paths.map((p) => ({ path: p, signedUrl: (opts.signed ?? {})[p] ?? null })),
            };
          },
        };
      },
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately structural, mirrors the untyped `sb` the real call sites pass
  return { sb: sb as any, calls };
}

describe("readPostPhotos — the projection", () => {
  it("names EXACTLY the three contract columns, in the contract's order", () => {
    // ENG-740's api-contract: `select post_id, sort_order, media_url from
    // post_media where post_id in (…) order by post_id, sort_order`.
    expect(POST_MEDIA_COLUMNS).toBe("post_id, sort_order, media_url");
  });

  it("sends that exact projection to post_media and nothing wider", async () => {
    const { sb, calls } = fakeSb({ rows: [] });
    await readPostPhotos(sb, ["p1"]);
    expect(calls.from).toEqual(["post_media"]);
    expect(calls.select).toEqual(["post_id, sort_order, media_url"]);
  });

  it("never widens the `post` projection — it reads its own table", async () => {
    // The whole point of the separate read: naming `post_media` columns on the
    // `post` select would 42703 the entire feed anywhere the migration is not
    // deployed, and that failure is a silent empty result, not a 500.
    const { sb, calls } = fakeSb({ rows: [] });
    await readPostPhotos(sb, ["p1"]);
    expect(calls.from).not.toContain("post");
  });

  it("orders by post_id then sort_order, ascending, as the contract states", async () => {
    const { sb, calls } = fakeSb({ rows: [] });
    await readPostPhotos(sb, ["p1"]);
    expect(calls.order).toEqual([
      ["post_id", { ascending: true }],
      ["sort_order", { ascending: true }],
    ]);
  });
});

describe("readPostPhotos — batching", () => {
  it("does ONE select and ONE signing round trip for a whole page of posts", async () => {
    const rows: Row[] = [
      { post_id: "p1", sort_order: 0, media_url: "p1/original" },
      { post_id: "p1", sort_order: 1, media_url: "p1/photo-1" },
      { post_id: "p2", sort_order: 0, media_url: "p2/original" },
      { post_id: "p2", sort_order: 1, media_url: "p2/photo-1" },
    ];
    const { sb, calls } = fakeSb({ rows });
    await readPostPhotos(sb, ["p1", "p2"]);
    // "Do not query per post" — the contract is explicit.
    expect(calls.select).toHaveLength(1);
    expect(calls.createSignedUrls).toHaveLength(1);
    expect(calls.createSignedUrls[0][0]).toEqual(["p1/original", "p1/photo-1", "p2/original", "p2/photo-1"]);
  });

  it("dedupes the ids it filters on", async () => {
    const { sb, calls } = fakeSb({ rows: [] });
    await readPostPhotos(sb, ["p1", "p1", "p2"]);
    expect(calls.in).toEqual([["post_id", ["p1", "p2"]]]);
  });

  it("signs against the private post-media bucket", async () => {
    const { sb, calls } = fakeSb({ rows: [{ post_id: "p1", sort_order: 0, media_url: "p1/original" }] });
    await readPostPhotos(sb, ["p1"]);
    expect(calls.storageFrom).toEqual(["post-media"]);
  });

  it("makes no query at all for an empty page", async () => {
    const { sb, calls } = fakeSb({ rows: [] });
    const out = await readPostPhotos(sb, []);
    expect(out.size).toBe(0);
    expect(calls.from).toEqual([]);
    expect(calls.createSignedUrls).toEqual([]);
  });
});

describe("readPostPhotos — grouping and order", () => {
  it("groups rows by post id and returns each post's photos signed", async () => {
    const rows: Row[] = [
      { post_id: "p1", sort_order: 0, media_url: "p1/original" },
      { post_id: "p1", sort_order: 1, media_url: "p1/photo-1" },
      { post_id: "p2", sort_order: 0, media_url: "p2/original" },
    ];
    const { sb } = fakeSb({
      rows,
      signed: {
        "p1/original": "https://signed/p1-0",
        "p1/photo-1": "https://signed/p1-1",
        "p2/original": "https://signed/p2-0",
      },
    });
    const out = await readPostPhotos(sb, ["p1", "p2"]);
    expect(out.get("p1")).toEqual([
      { url: "https://signed/p1-0", sort: 0 },
      { url: "https://signed/p1-1", sort: 1 },
    ]);
    expect(out.get("p2")).toEqual([{ url: "https://signed/p2-0", sort: 0 }]);
  });

  it("sorts by sort_order even when the wire order is scrambled", async () => {
    // The order is the PRODUCT behaviour — the admin chose it — so it is not
    // left to whatever order the rows happen to arrive in.
    const rows: Row[] = [
      { post_id: "p1", sort_order: 2, media_url: "c" },
      { post_id: "p1", sort_order: 0, media_url: "a" },
      { post_id: "p1", sort_order: 1, media_url: "b" },
    ];
    const { sb } = fakeSb({ rows, signed: { a: "A", b: "B", c: "C" } });
    const out = await readPostPhotos(sb, ["p1"]);
    expect(out.get("p1")?.map((p) => p.url)).toEqual(["A", "B", "C"]);
  });

  it("keeps NON-CONTIGUOUS sort_order values as the be sends them", async () => {
    // The contract says the DB does not enforce contiguity: `{0,3,7}` is legal.
    // Nothing downstream may infer position from array index.
    const rows: Row[] = [
      { post_id: "p1", sort_order: 7, media_url: "c" },
      { post_id: "p1", sort_order: 0, media_url: "a" },
      { post_id: "p1", sort_order: 3, media_url: "b" },
    ];
    const { sb } = fakeSb({ rows, signed: { a: "A", b: "B", c: "C" } });
    const out = await readPostPhotos(sb, ["p1"]);
    expect(out.get("p1")).toEqual([
      { url: "A", sort: 0 },
      { url: "B", sort: 3 },
      { url: "C", sort: 7 },
    ]);
  });

  it("leaves a post with no rows ABSENT rather than present-and-empty", async () => {
    // "0 rows" and "1 photo" are the same rendering case, and every legacy post
    // has 0 rows because ENG-740 ships no backfill.
    const { sb } = fakeSb({ rows: [{ post_id: "p1", sort_order: 0, media_url: "a" }], signed: { a: "A" } });
    const out = await readPostPhotos(sb, ["p1", "p-legacy"]);
    expect(out.has("p-legacy")).toBe(false);
  });
});

describe("readPostPhotos — degrading", () => {
  it("returns an empty map when the table is not deployed (42703), without throwing", async () => {
    // This is the ONLY reason it is safe for web to ship ahead of the be
    // migration: the feed keeps rendering from post.media_url.
    const { sb } = fakeSb({ error: { code: "42703", message: 'column "sort_order" does not exist' } });
    const out = await readPostPhotos(sb, ["p1"]);
    expect(out.size).toBe(0);
  });

  it("gives a photo that failed to sign a null url and still returns its siblings", async () => {
    const rows: Row[] = [
      { post_id: "p1", sort_order: 0, media_url: "ok" },
      { post_id: "p1", sort_order: 1, media_url: "dead" },
      { post_id: "p1", sort_order: 2, media_url: "ok2" },
    ];
    const { sb } = fakeSb({ rows, signed: { ok: "OK", ok2: "OK2" } });
    const out = await readPostPhotos(sb, ["p1"]);
    expect(out.get("p1")).toEqual([
      { url: "OK", sort: 0 },
      { url: null, sort: 1 },
      { url: "OK2", sort: 2 },
    ]);
  });

  it("survives the signing call returning no data at all", async () => {
    const rows: Row[] = [{ post_id: "p1", sort_order: 0, media_url: "a" }];
    const { sb } = fakeSb({ rows, signedData: null });
    const out = await readPostPhotos(sb, ["p1"]);
    expect(out.get("p1")).toEqual([{ url: null, sort: 0 }]);
  });
});

// THE MUTATION CHECK the ticket's gotcha demands (ENG-750: a mapper mutated to
// return null left a whole suite green because every proof used hand-built
// fixtures). These assert against the REAL `readPostPhotos`, so breaking the
// grouping, the signing lookup or the projection turns them red. Verified by
// hand during ENG-762 — see the PR for the four mutations and their failures.
describe("readPostPhotos — the mapping is genuinely exercised", () => {
  it("fails if the signed lookup is bypassed (url must be the SIGNED value, not the path)", async () => {
    const { sb } = fakeSb({
      rows: [{ post_id: "p1", sort_order: 0, media_url: "posts/p1.jpg" }],
      signed: { "posts/p1.jpg": "https://signed/p1?token=abc" },
    });
    const out = await readPostPhotos(sb, ["p1"]);
    const url = out.get("p1")?.[0]?.url;
    expect(url).toBe("https://signed/p1?token=abc");
    // Precisely what this proves: the value handed to the CARD is the signed
    // URL, never the object path. It does NOT prove "no path reaches the
    // browser" — the read is a client island, so the path is visible to browser
    // JS one step earlier by design (see the header of lib/post-media.ts). The
    // failure being guarded here is a path ending up in an `<img src>`.
    expect(url).not.toBe("posts/p1.jpg");
    expect(url).toContain("token=");
  });

  it("fails if sort is dropped or defaulted", async () => {
    const { sb } = fakeSb({
      rows: [
        { post_id: "p1", sort_order: 4, media_url: "a" },
        { post_id: "p1", sort_order: 9, media_url: "b" },
      ],
      signed: { a: "A", b: "B" },
    });
    const out = await readPostPhotos(sb, ["p1"]);
    expect(out.get("p1")?.map((p) => p.sort)).toEqual([4, 9]);
  });

  it("fails if every row is bucketed under one post id", async () => {
    const { sb } = fakeSb({
      rows: [
        { post_id: "p1", sort_order: 0, media_url: "a" },
        { post_id: "p2", sort_order: 0, media_url: "b" },
      ],
      signed: { a: "A", b: "B" },
    });
    const out = await readPostPhotos(sb, ["p1", "p2"]);
    expect(out.size).toBe(2);
    expect(out.get("p1")).toHaveLength(1);
    expect(out.get("p2")).toHaveLength(1);
  });
});
