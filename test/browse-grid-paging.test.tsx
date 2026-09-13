import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HorsesGrid } from "@/app/(member)/horses/horses-grid";
import { TrainersGrid } from "@/app/(member)/trainers/trainers-grid";
import { BROWSE_PAGE_SIZE, BROWSE_FETCH_LIMIT, browseRange, splitBrowsePage } from "@/lib/browse";
import { HORSE_PHOTO_BUCKET, TRAINER_PHOTO_BUCKET } from "@/lib/storage/photos";

// ENG-960 — the "Show more" pager. The ticket said "web perf PR #81 pages at 60
// with Show more; KEEP THAT MECHANISM", and an earlier revision of this PR
// shipped the 100 cap as a bare `.limit()` with no pager, which made row 101
// unreachable from browse. These tests pin that the cap now bounds each READ
// while every row stays reachable by clicking.
//
// The mock below is deliberately a REAL slice of a real array rather than a
// canned page, so a grid that stops calling `.range()` reads the whole table
// (exactly what the unpaged code did) and the reachability assertions catch it.

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

// ENG-999 retired the free trial, so `status: "trial"` is no longer entitled
// (lib/api/access.ts grants only `active` and `canceled`). The name says
// ENTITLED, so it is now a paid active row. Left as a trial it would silently
// turn every case in this file into a 402.
const ENTITLED_SUB = {
  data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" },
  error: null,
};

// A real ending, not a grace window — `lib/api/access.ts` `hasAccess()` walls
// a `canceled` row whose `current_period_end` has already passed, with no
// 3-day grace (that grace is `active`-only).
const LAPSED_SUB = {
  data: { status: "canceled", trial_ends_at: null, current_period_end: "2020-01-01T00:00:00Z" },
  error: null,
};

// The default signing echo (`.rx` shape from the ticket spec): every path
// comes back signed, keyed by bucket, so a test can assert the exact URL a
// card's `<img src>` should carry without hand-rolling this per test.
function echoSignedUrls(bucket: string) {
  return {
    createSignedUrls: vi.fn(async (paths: string[], _ttl: number) => ({
      data: paths.map((p) => ({ path: p, signedUrl: `https://sb.test/storage/v1/object/sign/${bucket}/${p}?token=t` })),
      error: null,
    })),
  };
}
function signedUrlFor(bucket: string, path: string) {
  return `https://sb.test/storage/v1/object/sign/${bucket}/${path}?token=t`;
}

function chainable(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order", "limit", "range", "maybeSingle", "single"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

/**
 * A chain backed by a whole table, sliced by whatever `.range()` it is given.
 * With NO `.range()` call it returns every row — modelling the unbounded read
 * this PR replaces, so deleting `.range()` from a grid is a detectable mutation
 * rather than a silently-identical one.
 */
function pagedChain(allRows: unknown[]) {
  const obj: Record<string, unknown> = {};
  let window: [number, number] | null = null;
  for (const method of ["select", "eq", "in", "not", "order", "limit", "maybeSingle", "single"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.range = vi.fn((from: number, to: number) => { window = [from, to]; return obj; });
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
    // `.range` bounds are inclusive, like PostgREST's.
    const data = window ? allRows.slice(window[0], window[1] + 1) : allRows;
    return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
  };
  return obj;
}

// ENG-1057 — both grids batch-sign each page's `photo_url` column via
// `signPhotoMap` (`sb.storage.from(bucket).createSignedUrls(paths, ttl)`). The
// existing mock had no `.storage` at all, so every test below would throw the
// moment a fixture carried a `photo_url`. `storageFromMock` is a `vi.fn()`
// (not a bare object) so the GUARDRAIL tests can assert it was never called
// for a lapsed member.
const { fromMock, storageFromMock } = vi.hoisted(() => ({ fromMock: vi.fn(), storageFromMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ from: fromMock, storage: { from: storageFromMock } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// Zero-padded so the fixture's own order matches the A-Z order the grid asks
// the database for — the test never depends on client-side sorting.
const horseRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `h-${String(i + 1).padStart(3, "0")}`,
    display_name: `Horse ${String(i + 1).padStart(3, "0")}`,
    racing_name: null,
    trainer: { name: "Waller" },
  }));

const trainerRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `t-${String(i + 1).padStart(3, "0")}`,
    name: `Trainer ${String(i + 1).padStart(3, "0")}`,
    display_name: null,
    stable_name: null,
    location: null,
    horses: [{ id: "x" }],
  }));

describe("ENG-960 browse paging — the cap bounds the read, the pager keeps every row reachable", () => {
  beforeEach(() => {
    fromMock.mockReset();
    storageFromMock.mockReset();
    storageFromMock.mockImplementation(echoSignedUrls);
  });

  it("splitBrowsePage renders a page and answers hasMore EXACTLY at the boundary", () => {
    // The off-by-one #81 has and this does not: at an exact multiple of the
    // page size, `rows.length === PAGE_SIZE` claims another page that is empty.
    // The bound the grids actually send, and the split that consumes it, must
    // agree: `browseRange` has to ask for exactly one row more than we render,
    // or `splitBrowsePage` mis-slices. Asserting the RELATIONSHIP rather than
    // restating BROWSE_FETCH_LIMIT's definition.
    const [from, to] = browseRange(0);
    expect(to - from + 1).toBe(BROWSE_PAGE_SIZE + 1);
    expect(browseRange(BROWSE_PAGE_SIZE)[0]).toBe(BROWSE_PAGE_SIZE); // page 2 starts where page 1 ended
    expect(BROWSE_FETCH_LIMIT).toBe(BROWSE_PAGE_SIZE + 1);

    const exact = splitBrowsePage(Array.from({ length: BROWSE_PAGE_SIZE }, (_, i) => i));
    expect(exact.page).toHaveLength(BROWSE_PAGE_SIZE);
    expect(exact.hasMore).toBe(false); // <- the fix: no button with nothing behind it

    const more = splitBrowsePage(Array.from({ length: BROWSE_PAGE_SIZE + 1 }, (_, i) => i));
    expect(more.page).toHaveLength(BROWSE_PAGE_SIZE); // the probe row is NOT rendered
    expect(more.hasMore).toBe(true);

    const short = splitBrowsePage([1, 2, 3]);
    expect(short.page).toHaveLength(3);
    expect(short.hasMore).toBe(false);
  });

  it("Horses: no row is unreachable — 239 fixtures, all reachable by Show more", async () => {
    const all = horseRows(239);
    const horseChain = pagedChain(all);
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return horseChain;
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => expect(screen.getByText("Horse 001")).toBeInTheDocument());
    // The cap really is a cap: row 101 is NOT on the first page.
    expect(screen.getByText(`Horse ${String(BROWSE_PAGE_SIZE).padStart(3, "0")}`)).toBeInTheDocument();
    expect(screen.queryByText("Horse 101")).not.toBeInTheDocument();
    // The read was bounded, and asked for exactly one probe row past the page.
    expect(horseChain.range).toHaveBeenCalledWith(0, BROWSE_PAGE_SIZE);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getByText("Horse 101")).toBeInTheDocument());
    // The next offset is the number of rows RENDERED, not the number fetched —
    // if the probe row leaked into the render this would be 101 and row 101
    // would be skipped.
    expect(horseChain.range).toHaveBeenCalledWith(BROWSE_PAGE_SIZE, BROWSE_PAGE_SIZE * 2);

    await user.click(screen.getByRole("button", { name: "Show more" }));
    // Row 239 — the last one, unreachable before this pager existed.
    await waitFor(() => expect(screen.getByText("Horse 239")).toBeInTheDocument());

    // EVERY fixture row is on screen, and each EXACTLY once — one DOM pass
    // rather than 239 queries (this test runs alongside the whole suite).
    // `length === 239` catches a duplicated row, `size === 239` a missing one.
    const rendered = (document.body.textContent ?? "").match(/Horse \d{3}/g) ?? [];
    expect(rendered).toHaveLength(all.length);
    expect(new Set(rendered).size).toBe(all.length);
    // The last page was short, so the pager retires rather than offering an
    // empty page.
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  }, 30000);

  it("Trainers: no row is unreachable — 241 fixtures, all reachable by Show more", async () => {
    const all = trainerRows(241);
    const trainerChain = pagedChain(all);
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "trainer") return trainerChain;
      return chainable({ data: null, error: null });
    });

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => expect(screen.getByText("Trainer 001")).toBeInTheDocument());
    expect(screen.queryByText("Trainer 101")).not.toBeInTheDocument();
    expect(trainerChain.range).toHaveBeenCalledWith(0, BROWSE_PAGE_SIZE);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getByText("Trainer 101")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getByText("Trainer 241")).toBeInTheDocument());

    const rendered = (document.body.textContent ?? "").match(/Trainer \d{3}/g) ?? [];
    expect(rendered).toHaveLength(all.length);
    expect(new Set(rendered).size).toBe(all.length);
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  }, 30000);

  it("both grids order TOTALLY (id tiebreaker) so a tie cannot shuffle a row across the page boundary", async () => {
    const horseChain = pagedChain(horseRows(5));
    const trainerChain = pagedChain(trainerRows(5));
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return horseChain;
      if (table === "trainer") return trainerChain;
      return chainable({ data: null, error: null });
    });

    const { unmount } = render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(horseChain.order).toHaveBeenCalledWith("display_name"));
    expect(horseChain.order).toHaveBeenCalledWith("id");
    unmount();

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(trainerChain.order).toHaveBeenCalledWith("name"));
    expect(trainerChain.order).toHaveBeenCalledWith("id");
  });

  it("a short first page offers no pager at all", async () => {
    const horseChain = pagedChain(horseRows(3));
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return horseChain;
      return chainable({ data: null, error: null });
    });
    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Horse 003")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("paging state resets on the All -> Following pill switch", async () => {
    // All has 239 rows (pager offered); Following has 2. Switching must reset
    // the roster AND the pager — inheriting All's `hasMore` would offer a
    // Show-more that pages into a stale offset.
    const all = horseRows(239);
    const followedIds = ["h-005", "h-006"];
    const horseChainAll = pagedChain(all);
    const horseChainFollowing = pagedChain(all.filter((h) => followedIds.includes(h.id)));
    let horseReads = 0;

    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "follow") {
        return chainable({ data: followedIds.map((id) => ({ horse_id: id })), error: null });
      }
      if (table === "horse") return ++horseReads === 1 ? horseChainAll : horseChainFollowing;
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Horse 001")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("browse-filter-following"));

    await waitFor(() => expect(screen.getByText("Horse 005")).toBeInTheDocument());
    expect(screen.getByText("Horse 006")).toBeInTheDocument();
    // The previous pill's roster is gone, not merely appended to.
    expect(screen.queryByText("Horse 001")).not.toBeInTheDocument();
    // And the pager is gone with it — 2 rows is a short page.
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    // Following re-read from offset 0, not from All's offset.
    expect(horseChainFollowing.range).toHaveBeenCalledWith(0, BROWSE_PAGE_SIZE);
  });

  it("INVARIANT: no rows, no roster container — the grid itself is gated on horses.length", async () => {
    // Replaces a test that could not bite. Its predecessor used a zero-row
    // fixture, so `splitBrowsePage` returned `hasMore: false` and the INNER
    // `{hasMore && (<button>)}` satisfied "no Show more" on its own, whatever
    // the outer gate said. Deleting `horses.length > 0` left all 1367 tests
    // green — the assertion tested `hasMore`, not the roster gate, while its
    // comment claimed the opposite (ENG-1016 class).
    //
    // So assert the gate's OWN observable effect instead: with no rows the
    // roster container does not render at all. Delete `horses.length > 0` and
    // an empty `.onboarding-grid-web` renders beneath the empty-state copy —
    // this reds, on the exact clause named.
    const horseChain = pagedChain([]);
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return horseChain;
      return chainable({ data: null, error: null });
    });
    const { container } = render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText(/No horses yet/)).toBeInTheDocument());
    expect(container.querySelector(".onboarding-grid-web")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("INVARIANT (trainers): no rows, no roster container — the same gate, pinned on the second grid", async () => {
    // The body claimed this invariant was "true for both grids and tested for
    // both". It was tested for neither. The trainers state machine is a
    // structural duplicate of the horses one, and duplicates drift, so the
    // gate is pinned here independently rather than by inspection.
    const trainerChain = pagedChain([]);
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "trainer") return trainerChain;
      return chainable({ data: null, error: null });
    });
    const { container } = render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    // Anchored on the settled empty state, NOT on the absence itself — a bare
    // `waitFor(...toBeNull())` passes on the very first tick, before the fetch
    // resolves, and would hold whatever the gate did.
    await waitFor(() => expect(screen.getByText(/No trainers yet/)).toBeInTheDocument());
    expect(container.querySelector(".onboarding-grid-web")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("the empty-follows short-circuit offers no pager (it returns before the roster query)", async () => {
    const horseChainAll = pagedChain(horseRows(239));
    let horseReads = 0;
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "follow") return chainable({ data: [], error: null });
      if (table === "horse") { horseReads += 1; return horseChainAll; }
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Horse 001")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
    expect(horseReads).toBe(1);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByTestId("browse-filter-following"));

    await waitFor(() => expect(screen.getByText(/not following any horses yet/)).toBeInTheDocument());
    // No pager left over from All...
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
    // ...and the short-circuit really did skip the roster round trip.
    expect(horseReads).toBe(1);
  });

  it("F1: a FAILED Show more keeps the roster and offers a retry — it must not wipe the page", async () => {
    // Regression guard. `setError(true)` unmounts the whole grid, which is
    // right for the first page and catastrophic for page 2+: it threw away the
    // 100 rows already on screen, and on Trainers (no pills to force a
    // refetch) that was unrecoverable without a full page reload.
    const all = horseRows(239);
    let call = 0;
    const horseChain: Record<string, unknown> = {};
    let window: [number, number] | null = null;
    for (const m of ["select", "eq", "in", "not", "order", "limit", "maybeSingle", "single"]) {
      horseChain[m] = vi.fn(() => horseChain);
    }
    horseChain.range = vi.fn((from: number, to: number) => { window = [from, to]; return horseChain; });
    horseChain.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => {
      call += 1;
      // Page 1 succeeds, page 2 fails, the retry of page 2 succeeds.
      if (call === 2) return Promise.resolve({ data: null, error: { message: "boom" } }).then(ok, err);
      const data = window ? all.slice(window[0], window[1] + 1) : all;
      return Promise.resolve({ data, error: null }).then(ok, err);
    };

    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return horseChain;
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Horse 001")).toBeInTheDocument());

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Show more" }));

    // The failure is reported...
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Couldn.t load more horses/));
    // ...and the 100 rows already loaded are STILL THERE.
    expect(screen.getByText("Horse 001")).toBeInTheDocument();
    expect(screen.getByText("Horse 100")).toBeInTheDocument();
    // The whole-screen error state did NOT fire.
    expect(screen.queryByText(/Couldn.t load horses\./)).not.toBeInTheDocument();

    // And the retry is one click, re-requesting the SAME offset (nothing was
    // appended, so the offset is still correct).
    const retry = screen.getByRole("button", { name: "Try again" });
    await user.click(retry);
    await waitFor(() => expect(screen.getByText("Horse 101")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(horseChain.range).toHaveBeenCalledWith(BROWSE_PAGE_SIZE, BROWSE_PAGE_SIZE * 2);
  }, 30000);

  it("F2: a load-more still in flight when the pill switches cannot append to the new roster", async () => {
    // Pins the `runRef` guard the fetch was restructured around. Every other
    // test resolves synchronously, so without this the guard could be deleted
    // and the suite would stay green.
    const all = horseRows(239);
    const followedIds = ["h-005", "h-006"];
    // Held in an object: TS narrows a plain `let` to `null` at the call site,
    // because the assignment happens inside a closure it cannot see run.
    const release: { fn: (() => void) | null } = { fn: null };
    let horseCall = 0;

    const makeChain = () => {
      const obj: Record<string, unknown> = {};
      let window: [number, number] | null = null;
      for (const m of ["select", "eq", "in", "not", "order", "limit", "maybeSingle", "single"]) {
        obj[m] = vi.fn(() => obj);
      }
      obj.range = vi.fn((from: number, to: number) => { window = [from, to]; return obj; });
      obj.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => {
        horseCall += 1;
        const slice = (rows: typeof all) => (window ? rows.slice(window[0], window[1] + 1) : rows);
        if (horseCall === 2) {
          // Page 2 of "All" — held open until after the pill switch.
          return new Promise<{ data: unknown; error: unknown }>((resolve) => {
            release.fn = () => resolve({ data: slice(all), error: null });
          }).then(ok, err);
        }
        if (horseCall >= 3) {
          return Promise.resolve({ data: slice(all.filter((h) => followedIds.includes(h.id))), error: null }).then(ok, err);
        }
        return Promise.resolve({ data: slice(all), error: null }).then(ok, err);
      };
      return obj;
    };
    const horseChain = makeChain();

    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "follow") return chainable({ data: followedIds.map((id) => ({ horse_id: id })), error: null });
      if (table === "horse") return horseChain;
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Horse 001")).toBeInTheDocument());

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Show more" })); // page 2 now hangs
    await user.click(screen.getByTestId("browse-filter-following"));
    await waitFor(() => expect(screen.getByText("Horse 005")).toBeInTheDocument());

    // Now let the abandoned All page land.
    release.fn?.();
    await waitFor(() => expect(screen.getByText("Horse 006")).toBeInTheDocument());

    // It must NOT have appended into the Following roster.
    expect(screen.queryByText("Horse 101")).not.toBeInTheDocument();
    expect(screen.queryByText("Horse 001")).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Horse \d{3}$/)).toHaveLength(2);
  }, 30000);

  it("F7: the no-rows-no-pager invariant holds for the TRAINERS grid too", async () => {
    const trainerChain = pagedChain([]);
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "trainer") return trainerChain;
      return chainable({ data: null, error: null });
    });
    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText(/No trainers yet/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("F1 (trainers): a failed Show more keeps the roster — this grid has no pills, so wiping it is UNRECOVERABLE", async () => {
    const all = trainerRows(241);
    let call = 0;
    const trainerChain: Record<string, unknown> = {};
    let window: [number, number] | null = null;
    for (const m of ["select", "eq", "in", "not", "order", "limit", "maybeSingle", "single"]) {
      trainerChain[m] = vi.fn(() => trainerChain);
    }
    trainerChain.range = vi.fn((from: number, to: number) => { window = [from, to]; return trainerChain; });
    trainerChain.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => {
      call += 1;
      if (call === 2) return Promise.resolve({ data: null, error: { message: "boom" } }).then(ok, err);
      const data = window ? all.slice(window[0], window[1] + 1) : all;
      return Promise.resolve({ data, error: null }).then(ok, err);
    };

    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "trainer") return trainerChain;
      return chainable({ data: null, error: null });
    });

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Trainer 001")).toBeInTheDocument());

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Show more" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Couldn.t load more trainers/));
    expect(screen.getByText("Trainer 001")).toBeInTheDocument();
    expect(screen.getByText("Trainer 100")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn.t load trainers\./)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByText("Trainer 101")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  }, 30000);
});

describe("ENG-1057 — browse cards render SIGNED photo urls, never a bare stored path", () => {
  beforeEach(() => {
    fromMock.mockReset();
    storageFromMock.mockReset();
    storageFromMock.mockImplementation(echoSignedUrls);
  });

  it("Horses: each card's <img src> is the mocked signed URL for that row's photo_url", async () => {
    const rows = [
      { id: "h-1", display_name: "Mahogany", racing_name: null, photo_url: "horses/mahogany.jpg", trainer: { name: "Waller" } },
      { id: "h-2", display_name: "Kingston", racing_name: null, photo_url: null, trainer: { name: "Waller" } },
    ];
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return chainable({ data: rows, error: null });
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Mahogany")).toBeInTheDocument());

    const mahoganyCard = screen.getByText("Mahogany").closest("button")!;
    const mahoganyImg = mahoganyCard.querySelector("img")!;
    expect(mahoganyImg).toHaveAttribute("src", signedUrlFor(HORSE_PHOTO_BUCKET, "horses/mahogany.jpg"));
    expect(mahoganyImg).toHaveClass("horse-thumb-photo");

    // Kingston has no photo_url at all — the initial, no <img>.
    const kingstonCard = screen.getByText("Kingston").closest("button")!;
    expect(kingstonCard.querySelector("img")).toBeNull();
    expect(kingstonCard.querySelector(".horse-thumb")!.textContent).toBe("K");
  });

  // `sb` is untyped, so `tsc` can never catch a too-narrow `.select()`: deleting
  // `photo_url` from the horses read leaves the whole suite green (verified by
  // hand before adding this — every other assertion in this file only inspects
  // the SIGNED map, never the projection string sent to the database).
  it("pins the horses-grid read's exact projection, including photo_url", async () => {
    const rows = [{ id: "h-1", display_name: "Mahogany", racing_name: null, photo_url: null, trainer: { name: "Waller" } }];
    const horseChain = chainable({ data: rows, error: null });
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return horseChain;
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Mahogany")).toBeInTheDocument());

    expect(horseChain.select).toHaveBeenCalledWith(
      "id, display_name, racing_name, photo_url, trainer:trainer_id(name)",
    );
  });

  it("Trainers: each card's <img src> is the mocked signed URL for that row's photo_url", async () => {
    const rows = [
      { id: "t-1", name: "Chris Waller", display_name: null, stable_name: null, location: null, photo_url: "trainers/waller.jpg", horses: [{ id: "x" }] },
      { id: "t-2", name: "Gai Waterhouse", display_name: null, stable_name: null, location: null, photo_url: null, horses: [{ id: "y" }] },
    ];
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "trainer") return chainable({ data: rows, error: null });
      return chainable({ data: null, error: null });
    });

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Chris Waller")).toBeInTheDocument());

    const wallerCard = screen.getByText("Chris Waller").closest("button")!;
    const wallerImg = wallerCard.querySelector("img")!;
    expect(wallerImg).toHaveAttribute("src", signedUrlFor(TRAINER_PHOTO_BUCKET, "trainers/waller.jpg"));
    expect(wallerImg).toHaveClass("trainer-thumb-photo");

    // Gai Waterhouse has no photo_url at all — the initials, no <img>.
    const gaiCard = screen.getByText("Gai Waterhouse").closest("button")!;
    expect(gaiCard.querySelector("img")).toBeNull();
    expect(gaiCard.querySelector(".trainer-thumb")!.textContent).toBe("GW");
  });

  it("a row whose photo_url is ABSENT from the signer's response renders the INITIAL and no <img>", async () => {
    const rows = [
      { id: "h-1", display_name: "Present", racing_name: null, photo_url: "horses/present.jpg", trainer: { name: "Waller" } },
      { id: "h-2", display_name: "Missing", racing_name: null, photo_url: "horses/missing.jpg", trainer: { name: "Waller" } },
    ];
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return chainable({ data: rows, error: null });
      return chainable({ data: null, error: null });
    });
    // The signer answers for "present.jpg" only — models a denied/missing
    // Storage object for "missing.jpg", exactly what `signPhotoMap` treats as
    // "no photo" (it never throws on a per-path gap).
    storageFromMock.mockImplementation((bucket: string) => ({
      createSignedUrls: vi.fn(async (paths: string[]) => ({
        data: paths
          .filter((p) => p !== "horses/missing.jpg")
          .map((p) => ({ path: p, signedUrl: signedUrlFor(bucket, p) })),
        error: null,
      })),
    }));

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Present")).toBeInTheDocument());

    const presentCard = screen.getByText("Present").closest("button")!;
    expect(presentCard.querySelector("img")).toHaveAttribute("src", signedUrlFor(HORSE_PHOTO_BUCKET, "horses/present.jpg"));

    const missingCard = screen.getByText("Missing").closest("button")!;
    expect(missingCard.querySelector("img")).toBeNull();
    expect(missingCard.querySelector(".horse-thumb")!.textContent).toBe("M");
  });

  it("GUARDRAIL: a signer returning no rows never lets the bare stored path reach <img src>", async () => {
    const rows = [
      { id: "h-1", display_name: "Guarded", racing_name: null, photo_url: "abc.jpg", trainer: { name: "Waller" } },
    ];
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return chainable({ data: rows, error: null });
      return chainable({ data: null, error: null });
    });
    // The signer refuses every path — models a wholesale RLS denial rather
    // than one bad object.
    storageFromMock.mockImplementation(() => ({
      createSignedUrls: vi.fn(async () => ({ data: [], error: null })),
    }));

    const { container } = render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Guarded")).toBeInTheDocument());

    for (const img of Array.from(container.querySelectorAll("img"))) {
      const src = img.getAttribute("src") ?? "";
      expect(src).not.toBe("abc.jpg");
      expect(src.endsWith("abc.jpg")).toBe(false);
    }
    // In fact there is no <img> at all — the row falls all the way back to
    // its initial.
    expect(container.querySelectorAll("img")).toHaveLength(0);
    const guardedCard = screen.getByText("Guarded").closest("button")!;
    expect(guardedCard.querySelector(".horse-thumb")!.textContent).toBe("G");
  });

  it("GUARDRAIL (horses): a lapsed subscription renders the AccessWall and never touches storage", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(LAPSED_SUB);
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed />);

    await waitFor(() => expect(screen.getByTestId("access-wall")).toBeInTheDocument());
    expect(storageFromMock).not.toHaveBeenCalled();
  });

  it("GUARDRAIL (trainers): a lapsed subscription renders the AccessWall and never touches storage", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(LAPSED_SUB);
      return chainable({ data: null, error: null });
    });

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed />);

    await waitFor(() => expect(screen.getByTestId("access-wall")).toBeInTheDocument());
    expect(storageFromMock).not.toHaveBeenCalled();
  });
});
