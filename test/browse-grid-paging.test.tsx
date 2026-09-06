import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HorsesGrid } from "@/app/(member)/horses/horses-grid";
import { TrainersGrid } from "@/app/(member)/trainers/trainers-grid";
import { BROWSE_PAGE_SIZE, BROWSE_FETCH_LIMIT, splitBrowsePage } from "@/lib/browse";

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

const ENTITLED_SUB = {
  data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null },
  error: null,
};

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

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ from: fromMock }) }));
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
  beforeEach(() => { fromMock.mockReset(); });

  it("splitBrowsePage renders a page and answers hasMore EXACTLY at the boundary", () => {
    // The off-by-one #81 has and this does not: at an exact multiple of the
    // page size, `rows.length === PAGE_SIZE` claims another page that is empty.
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
});
