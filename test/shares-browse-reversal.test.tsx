import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HorsesGrid } from "@/app/(member)/horses/horses-grid";
import { TrainersGrid } from "@/app/(member)/trainers/trainers-grid";
import { BROWSE_PAGE_SIZE } from "@/lib/browse";

// ENG-960 / R8 reversal. This file used to be `shares-browse-segregation.test.tsx`
// and asserted the ENG-831 rule ("for-sale horses never appear in browse").
// That rule was a LIVE BUG: a stable whose horses are all for sale rendered an
// empty Horses grid and a "0 horses" card on web. The tests below are the same
// two scenarios with the expectation reversed, plus the for-sale-only stable
// pinned explicitly — the case the parity audit found in production.

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

function chainable(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order", "limit", "range", "maybeSingle", "single"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

const ENTITLED_SUB = {
  data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null },
  error: null,
};

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ from: fromMock }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("ENG-960 browse reversal — for-sale horses fold back into browse", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("Horses browse does NOT filter shares_for_sale — a for-sale-only roster renders", async () => {
    // Every horse here is for sale. Under ENG-831 the query excluded them all
    // and this screen showed "No horses yet — check back soon."
    const horseChain = chainable({
      data: [
        { id: "h-sale-1", display_name: "Mahogany", racing_name: null, trainer: { name: "Waller" } },
        { id: "h-sale-2", display_name: "Kingston", racing_name: null, trainer: { name: "Waller" } },
      ],
      error: null,
    });
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return horseChain;
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => {
      expect(screen.getByText("Mahogany")).toBeInTheDocument();
    });
    expect(screen.getByText("Kingston")).toBeInTheDocument();
    expect(screen.queryByText(/No horses yet/)).not.toBeInTheDocument();

    // Platform visibility is still enforced; the shares exclusion is not.
    expect(horseChain.eq).toHaveBeenCalledWith("status", "active");
    expect(horseChain.eq).not.toHaveBeenCalledWith("shares_for_sale", false);
  });

  it("Trainers browse counts EVERY active horse — a for-sale-only stable is not '0 horses'", async () => {
    const trainerChain = chainable({
      data: [
        {
          id: "t1",
          name: "Chris Waller",
          display_name: null,
          stable_name: "Waller Racing",
          location: "Warwick Farm",
          // The roster the trainer's own profile page now lists. Under ENG-831
          // the card said "0 horses" while the profile one click away listed
          // three — the contradiction this ticket removes.
          // Every one of them for sale, and the flag PRESENT on the row. An
          // absent flag would make a restored `!h.shares_for_sale` filter count
          // `!undefined === true` for every row — the count would still say 3
          // and the mutation would pass unnoticed.
          horses: [
            { id: "h1", shares_for_sale: true },
            { id: "h2", shares_for_sale: true },
            { id: "h3", shares_for_sale: true },
          ],
        },
      ],
      error: null,
    });
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "trainer") return trainerChain;
      return chainable({ data: null, error: null });
    });

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => {
      expect(screen.getByText("Chris Waller")).toBeInTheDocument();
    });
    expect(screen.getByText("3 horses")).toBeInTheDocument();
    expect(screen.queryByText("0 horses")).not.toBeInTheDocument();

    // The flag is no longer even selected — the second of the three coupled
    // sites. A projection that still fetched it would mean the filter could
    // quietly come back.
    expect(trainerChain.select).toHaveBeenCalledWith(
      "id, name, display_name, stable_name, location, horses:horse!trainer_id(id)",
    );
  });

  it("Trainers browse: one horse still reads '1 horse' (singular unaffected by the count change)", async () => {
    const trainerChain = chainable({
      data: [
        {
          id: "t1",
          name: "Chris Waller",
          display_name: null,
          stable_name: null,
          location: null,
          horses: [{ id: "h1", shares_for_sale: true }],
        },
      ],
      error: null,
    });
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "trainer") return trainerChain;
      return chainable({ data: null, error: null });
    });

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => {
      expect(screen.getByText("1 horse")).toBeInTheDocument();
    });
  });

  it("both grids bound the read at BROWSE_PAGE_SIZE (100) via .range, never unbounded", async () => {
    const horseChain = chainable({ data: [], error: null });
    const trainerChain = chainable({ data: [], error: null });
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return horseChain;
      if (table === "trainer") return trainerChain;
      return chainable({ data: null, error: null });
    });

    // `.range` is inclusive, so (0, PAGE_SIZE) is PAGE_SIZE + 1 rows: the page
    // we render plus the one probe row that answers "is there more?" exactly.
    // The bound is on the QUERY BUILDER, not a client-side slice — a grid that
    // dropped it would read the whole table.
    const { unmount } = render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(horseChain.range).toHaveBeenCalledWith(0, BROWSE_PAGE_SIZE));
    expect(horseChain.limit).not.toHaveBeenCalled();
    unmount();

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(trainerChain.range).toHaveBeenCalledWith(0, BROWSE_PAGE_SIZE));
    expect(trainerChain.limit).not.toHaveBeenCalled();

    // Pin the number itself, not just that both agree — the ticket asks for
    // mobile's BROWSE_PAGE_SIZE, which is 100. Reachability past it is proved
    // in test/browse-grid-paging.test.tsx.
    expect(BROWSE_PAGE_SIZE).toBe(100);
  });
});
