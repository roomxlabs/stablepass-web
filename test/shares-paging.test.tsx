import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SharesList, SHARES_PAGE_SIZE } from "@/app/(member)/shares/shares-list";
import { BROWSE_PAGE_SIZE } from "@/lib/browse";

// ENG-1038 — /shares was the last member browse surface still shipping the
// truncating cap ENG-960 removed from Horses and Trainers: `.limit(100)` with
// NO pager, so row 101 of a stable's for-sale roster was unreachable and there
// was no affordance to reach it.
//
// These tests are the /shares counterpart of ENG-960's `browse-grid-paging.test.tsx`
// and are deliberately the same shape, because the same two mutations have to
// stay red on all three surfaces.
//
// The mock is a REAL slice of a real array rather than a canned page, on
// purpose: a screen that stops calling `.range()` then reads the WHOLE table
// (exactly what the truncating code did), and the reachability assertions below
// catch it. A canned page would return the same 100 rows either way and the
// mutation would be invisible.

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";
const ACTIVE_SUB = { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00.000Z" };

function chainable(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order", "limit", "range"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.maybeSingle = vi.fn(() => Promise.resolve(result));
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

/**
 * A chain backed by a whole table, sliced by whatever `.range()` it is given.
 * With NO `.range()` call it returns every row, so deleting `.range()` from the
 * screen is a DETECTABLE mutation rather than a silently-identical one.
 *
 * `failAtOffset` makes exactly one page fail, which is how the error split is
 * pinned: the same failure must be destructive at offset 0 and non-destructive
 * after it.
 */
function pagedChain(allRows: unknown[], failAtOffset: number | null = null) {
  const obj: Record<string, unknown> = {};
  let window: [number, number] | null = null;
  for (const method of ["select", "eq", "in", "not", "order", "limit", "maybeSingle", "single"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.range = vi.fn((from: number, to: number) => {
    window = [from, to];
    return obj;
  });
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
    if (window && failAtOffset !== null && window[0] === failAtOffset) {
      return Promise.resolve({ data: null, error: { message: "boom" } }).then(onFulfilled, onRejected);
    }
    // `.range` bounds are inclusive, like PostgREST's.
    const data = window ? allRows.slice(window[0], window[1] + 1) : allRows;
    return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
  };
  return obj;
}

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ from: fromMock }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Zero-padded so the fixture's own order matches the A-Z order the screen asks
// the database for. `racing_name` is null throughout, so the RESOLVED name the
// row renders is the `display_name` — which keeps this test independent of
// `mapSharesHorses`'s client-side sort and lets it measure paging only.
const horseRows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `h-${String(i + 1).padStart(3, "0")}`,
    display_name: `Sharehorse ${String(i + 1).padStart(3, "0")}`,
    racing_name: null,
    training_status: "racing",
    trainer: { id: "t1", name: "Chris Waller", website_url: "https://wallerracing.example" },
  }));

function mountPaged(all: unknown[], failAtOffset: number | null = null) {
  const horseChain = pagedChain(all, failAtOffset);
  fromMock.mockImplementation((table: string) => {
    if (table === "subscription") return chainable({ data: ACTIVE_SUB, error: null });
    if (table === "horse") return horseChain;
    return chainable({ data: [], error: null });
  });
  render(<SharesList viewerId={VIEWER_ID} everSubscribed={false} />);
  return horseChain;
}

describe("ENG-1038 /shares paging — the cap bounds the read, the pager keeps every row reachable", () => {
  beforeEach(() => {
    fromMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, status: 204 })));
  });

  it("the page size is the shared browse one, not a second independent 100", () => {
    // Two constants both justified as "mirrors mobile's BROWSE_PAGE_SIZE" is
    // two places to change and one to forget. Pinning the alias, so a future
    // edit to either has to be a deliberate divergence.
    expect(SHARES_PAGE_SIZE).toBe(BROWSE_PAGE_SIZE);
  });

  it("no row is unreachable — 239 for-sale fixtures, all reachable by Show more", async () => {
    const all = horseRows(239);
    const horseChain = mountPaged(all);

    await waitFor(() => expect(screen.getByText("Sharehorse 001")).toBeInTheDocument());

    // The cap really is a cap: row 101 is NOT on the first page...
    expect(screen.getByText(`Sharehorse ${String(SHARES_PAGE_SIZE).padStart(3, "0")}`)).toBeInTheDocument();
    expect(screen.queryByText("Sharehorse 101")).not.toBeInTheDocument();
    // ...and the read was bounded, asking for exactly one probe row past it.
    expect(horseChain.range).toHaveBeenCalledWith(0, SHARES_PAGE_SIZE);

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getByText("Sharehorse 101")).toBeInTheDocument());
    // The next offset is the number of rows RENDERED, not the number FETCHED.
    // If the probe row leaked into the render this would be 101 and Sharehorse
    // 101 would be skipped entirely — the off-by-one ENG-960 fixed in #81.
    expect(horseChain.range).toHaveBeenCalledWith(SHARES_PAGE_SIZE, SHARES_PAGE_SIZE * 2);

    await user.click(screen.getByRole("button", { name: "Show more" }));
    // Row 239 — the last one, silently unreachable before this pager existed.
    await waitFor(() => expect(screen.getByText("Sharehorse 239")).toBeInTheDocument());

    // EVERY fixture row is on screen, each EXACTLY once — one DOM pass rather
    // than 239 queries. `toHaveLength` catches a DUPLICATED row (an offset that
    // re-reads rows it already rendered), `new Set(...).size` a DROPPED one (an
    // offset that skips past them).
    const rendered = (document.body.textContent ?? "").match(/Sharehorse \d{3}/g) ?? [];
    expect(rendered).toHaveLength(all.length);
    expect(new Set(rendered).size).toBe(all.length);

    // The last page was short, so the pager RETIRES rather than offering a page
    // with nothing behind it.
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  }, 30000);

  it("the pager never appears when a single short page holds the whole roster", async () => {
    mountPaged(horseRows(23));
    await waitFor(() => expect(screen.getByTestId("shares-list")).toBeInTheDocument());
    expect(screen.getByText("Sharehorse 023")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("retires the pager at an EXACT multiple of the page size — no empty last page", async () => {
    // The boundary #81's `rows.length === PAGE_SIZE` gets wrong: at exactly 100
    // rows the last full page offers "Show more" and pressing it fetches
    // nothing. The probe row answers it exactly.
    mountPaged(horseRows(SHARES_PAGE_SIZE));
    await waitFor(() => expect(screen.getByTestId("shares-list")).toBeInTheDocument());
    expect(screen.getByText(`Sharehorse ${String(SHARES_PAGE_SIZE).padStart(3, "0")}`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  }, 30000);

  it("a failed FIRST page is destructive — there is no roster worth keeping", async () => {
    mountPaged(horseRows(239), 0);
    await waitFor(() => expect(screen.getByTestId("shares-error")).toBeInTheDocument());
    expect(screen.queryByTestId("shares-list")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show more|Try again/ })).not.toBeInTheDocument();
  });

  it("a failed LATER page KEEPS the roster and offers a one-click retry", async () => {
    // The regression ENG-960's self-review caught, and the reason `error` and
    // `pageError` are separate states. /shares has no filter pills, so nothing
    // on this screen ever re-runs offset 0 for the life of the mount — routing
    // this into `error` would unmount 100 good rows and leave the member with
    // no way back except a full page reload.
    const horseChain = mountPaged(horseRows(239), SHARES_PAGE_SIZE);
    await waitFor(() => expect(screen.getByText("Sharehorse 001")).toBeInTheDocument());

    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole("button", { name: "Show more" }));

    await waitFor(() => expect(screen.getByTestId("shares-page-error")).toBeInTheDocument());
    // The roster SURVIVED — this is the whole point of the split.
    expect(screen.getByTestId("shares-list")).toBeInTheDocument();
    expect(screen.getByText("Sharehorse 001")).toBeInTheDocument();
    expect(screen.getByText("Sharehorse 100")).toBeInTheDocument();
    // ...and the destructive full-screen error did NOT take over.
    expect(screen.queryByTestId("shares-error")).not.toBeInTheDocument();
    // The pager survives too, relabelled — losing it is what would make this
    // unrecoverable.
    const retry = screen.getByRole("button", { name: "Try again" });

    // And the retry genuinely re-fetches the SAME offset, rather than being a
    // button that renders but fetches nothing.
    (horseChain.range as ReturnType<typeof vi.fn>).mockClear();
    await user.click(retry);
    await waitFor(() => expect(horseChain.range).toHaveBeenCalledWith(SHARES_PAGE_SIZE, SHARES_PAGE_SIZE * 2));
  }, 30000);

  // Pins the `runRef` generation counter that replaced the old `cancelled`
  // boolean. Self-review caught that the guard was correct but INVISIBLE:
  // deleting both `if (!live()) return;` lines left all 1345 tests green.
  //
  // Two dead ends worth recording, because both LOOK like they test this and
  // neither does (each was written, run against the mutant, and passed):
  //   - unmount mid-flight and expect React's "setState on an unmounted
  //     component" warning — React 18 removed that warning entirely;
  //   - gate the mock on a mutable `current viewer` flag — the superseded
  //     request reads the flag AFTER it has already flipped, so it fetches the
  //     new viewer's rows and there is nothing stale left to observe.
  // The gate has to be keyed on WHICH CALL it is, so request A genuinely stays
  // parked holding A's data while B completes.
  const deferred = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    return { gate, release };
  };

  const A_ROW = { id: "a-1", display_name: "Stale Viewer A Horse", racing_name: null, training_status: "racing", trainer: { id: "t1", name: "Waller", website_url: null } };
  const B_ROW = { id: "b-1", display_name: "Fresh Viewer B Horse", racing_name: null, training_status: "racing", trainer: { id: "t1", name: "Waller", website_url: null } };

  function heldChain(result: { data: unknown; error: unknown }, gate: Promise<void> | null) {
    const obj: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "order", "limit", "range"]) {
      obj[m] = vi.fn(() => obj);
    }
    const settle = async () => { if (gate) await gate; return result; };
    obj.maybeSingle = vi.fn(settle);
    obj.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => settle().then(onF, onR);
    return obj;
  }

  it("a superseded HORSE read never overwrites the new roster — runRef liveness", async () => {
    const { gate, release } = deferred();
    let horseCalls = 0;
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return heldChain({ data: ACTIVE_SUB, error: null }, null);
      if (table === "horse") {
        horseCalls += 1;
        // Call 1 is viewer A's and stays PARKED holding A's row; every later
        // call is B's and resolves at once.
        return horseCalls === 1
          ? heldChain({ data: [A_ROW], error: null }, gate)
          : heldChain({ data: [B_ROW], error: null }, null);
      }
      return heldChain({ data: [], error: null }, null);
    });

    const { rerender } = render(<SharesList viewerId={VIEWER_ID} everSubscribed={false} />);
    // Let A actually REACH and park on its horse read before superseding it.
    // Superseding earlier proves nothing: the guard after the subscription read
    // makes A return before it ever queries horses, so call 1 would be B's and
    // the fixtures would be back to front (this test failed exactly that way
    // when written without the wait).
    await waitFor(() => expect(fromMock.mock.calls.filter((c) => c[0] === "horse")).toHaveLength(1));
    rerender(<SharesList viewerId="11111111-2222-4333-8444-555555555555" everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Fresh Viewer B Horse")).toBeInTheDocument());

    // Release A and DRAIN its continuation before asserting. A `waitFor` on B's
    // row is useless here — already satisfied, so it returns before A's
    // microtasks run and the test passes even against the mutant.
    release();
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

    // A's write must have been discarded: offset 0 REPLACES the roster, so
    // without the guard "Stale Viewer A Horse" is what is on screen.
    expect(screen.queryByText("Stale Viewer A Horse")).not.toBeInTheDocument();
    expect(screen.getByText("Fresh Viewer B Horse")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  }, 30000);

  it("a superseded SUBSCRIPTION read stops before it ever queries horses", async () => {
    // The guard after the FIRST await. Its effect is not a wrong row — by the
    // time A resumes, a horse query would return B's data anyway — it is that A
    // must not issue that second query AT ALL. So the assertion is the call
    // count: exactly one horse read, B's.
    const { gate, release } = deferred();
    let subCalls = 0;
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") {
        subCalls += 1;
        return heldChain({ data: ACTIVE_SUB, error: null }, subCalls === 1 ? gate : null);
      }
      if (table === "horse") return heldChain({ data: [B_ROW], error: null }, null);
      return heldChain({ data: [], error: null }, null);
    });

    const { rerender } = render(<SharesList viewerId={VIEWER_ID} everSubscribed={false} />);
    rerender(<SharesList viewerId="11111111-2222-4333-8444-555555555555" everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Fresh Viewer B Horse")).toBeInTheDocument());

    const horseReadsBefore = fromMock.mock.calls.filter((c) => c[0] === "horse").length;
    expect(horseReadsBefore).toBe(1);

    release();
    await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

    // A resumed, found itself superseded, and returned WITHOUT querying horses.
    expect(fromMock.mock.calls.filter((c) => c[0] === "horse")).toHaveLength(1);
  }, 30000);

  it("keeps the for-sale scope on EVERY page, not just the first", async () => {
    // The guardrail (`shares_for_sale = true`) is what makes this screen the
    // shares list rather than browse. A page-2 query that dropped it would leak
    // non-for-sale horses into /shares, and the first-page-only assertion in
    // shares-list.test.tsx would not see it.
    const horseChain = mountPaged(horseRows(239));
    await waitFor(() => expect(screen.getByText("Sharehorse 001")).toBeInTheDocument());

    const user = userEvent.setup({ delay: null });
    (horseChain.eq as ReturnType<typeof vi.fn>).mockClear();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getByText("Sharehorse 101")).toBeInTheDocument());

    expect(horseChain.eq).toHaveBeenCalledWith("shares_for_sale", true);
    expect(horseChain.eq).toHaveBeenCalledWith("status", "active");
  }, 30000);
});
