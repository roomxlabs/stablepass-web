import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HorsesGrid } from "@/app/(member)/horses/horses-grid";
import { BROWSE_FILTERS } from "@/components/browse-filter";

// ENG-960 — the All | Following pills on the Horses browse screen, mirroring
// mobile's `src/components/browse-filter.tsx`. ENG-870 dropped mobile back to
// exactly this pair; Racehorses / Retired / Shares are gone.

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

// ENG-999 retired the free trial, so `status: "trial"` is no longer entitled
// (lib/api/access.ts grants only `active` and `canceled`). The name says
// ENTITLED, so it is now a paid active row. Left as a trial it would silently
// turn every case in this file into a 402.
const ENTITLED_SUB = {
  data: { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00Z" },
  error: null,
};

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ from: fromMock }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

/** Wire the three tables the grid can read, returning fresh spies each time. */
function mockTables(opts: {
  horses?: { data: unknown; error: unknown };
  follows?: { data: unknown; error: unknown };
}) {
  const horseChain = chainable(opts.horses ?? { data: [], error: null });
  const followChain = chainable(opts.follows ?? { data: [], error: null });
  fromMock.mockImplementation((table: string) => {
    if (table === "subscription") return chainable(ENTITLED_SUB);
    if (table === "horse") return horseChain;
    if (table === "follow") return followChain;
    return chainable({ data: null, error: null });
  });
  return { horseChain, followChain };
}

describe("ENG-960 browse pills — All | Following", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("offers exactly All and Following — Racehorses and Retired are gone", async () => {
    mockTables({});
    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("browse-filter")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Show all" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show following" })).toBeInTheDocument();
    expect(screen.queryByText("Racehorses")).not.toBeInTheDocument();
    expect(screen.queryByText("Retired")).not.toBeInTheDocument();
    expect(screen.queryByText("Shares")).not.toBeInTheDocument();
    // The exported set is the contract mobile mirrors.
    expect([...BROWSE_FILTERS]).toEqual(["all", "following"]);
  });

  it("defaults to All, with All pressed and Following not", async () => {
    mockTables({ horses: { data: [{ id: "h1", display_name: "Mahogany", racing_name: null, trainer: null }], error: null } });
    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => expect(screen.getByText("Mahogany")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Show all" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Show following" })).toHaveAttribute("aria-pressed", "false");
  });

  it("All does NOT read the follow table — it is the unfiltered roster", async () => {
    mockTables({});
    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => expect(screen.getByTestId("browse-filter")).toBeInTheDocument());
    expect(fromMock).not.toHaveBeenCalledWith("follow");
  });

  it("Following scopes the roster to the horses the viewer follows", async () => {
    const { horseChain, followChain } = mockTables({
      follows: { data: [{ horse_id: "h-2" }, { horse_id: "h-9" }], error: null },
      horses: { data: [{ id: "h-2", display_name: "Kingston", racing_name: null, trainer: null }], error: null },
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByTestId("browse-filter")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Show following" }));

    await waitFor(() => expect(screen.getByText("Kingston")).toBeInTheDocument());

    // Scoped to this viewer's own follow rows, horse follows only (a trainer
    // follow carries `horse_id IS NULL`).
    expect(followChain.eq).toHaveBeenCalledWith("user_id", VIEWER_ID);
    expect(followChain.not).toHaveBeenCalledWith("horse_id", "is", null);
    expect(horseChain.in).toHaveBeenCalledWith("id", ["h-2", "h-9"]);
    expect(screen.getByRole("button", { name: "Show following" })).toHaveAttribute("aria-pressed", "true");
  });

  it("Following with no follows short-circuits: no roster read, and its own empty copy", async () => {
    const { horseChain } = mockTables({ follows: { data: [], error: null } });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByTestId("browse-filter")).toBeInTheDocument());
    // The initial "All" render already ran one horse read; count from here.
    horseChain.in = vi.fn(() => horseChain);
    const readsBefore = (horseChain.select as ReturnType<typeof vi.fn>).mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: "Show following" }));

    await waitFor(() => {
      expect(screen.getByText("You’re not following any horses yet.")).toBeInTheDocument();
    });
    // `.in("id", [])` is a wasted round trip whose answer we already know.
    expect((horseChain.select as ReturnType<typeof vi.fn>).mock.calls.length).toBe(readsBefore);
    expect(horseChain.in).not.toHaveBeenCalled();
    expect(screen.queryByText(/No horses yet/)).not.toBeInTheDocument();
  });

  it("a FAILED follow read is an error, never 'you follow nothing'", async () => {
    mockTables({ follows: { data: null, error: { message: "boom" } } });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByTestId("browse-filter")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Show following" }));

    await waitFor(() => {
      expect(screen.getByText(/Couldn’t load horses\./)).toBeInTheDocument();
    });
    // Showing the empty-state copy here would tell a member who follows plenty
    // that they follow nothing.
    expect(screen.queryByText("You’re not following any horses yet.")).not.toBeInTheDocument();
  });

  it("switching back to All drops the id scope and re-reads the full roster", async () => {
    const { horseChain } = mockTables({
      follows: { data: [{ horse_id: "h-2" }], error: null },
      horses: { data: [{ id: "h-2", display_name: "Kingston", racing_name: null, trainer: null }], error: null },
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByTestId("browse-filter")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Show following" }));
    await waitFor(() => expect(horseChain.in).toHaveBeenCalledWith("id", ["h-2"]));

    (horseChain.in as ReturnType<typeof vi.fn>).mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Show all" })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(horseChain.in).not.toHaveBeenCalled();
  });

  it("following horses that are all unavailable is NOT 'you follow nothing'", async () => {
    // The viewer DOES follow horses; the roster read just comes back empty
    // (retired, hidden, RLS-invisible). Claiming they follow nothing is a false
    // statement about the viewer.
    mockTables({
      follows: { data: [{ horse_id: "h-gone" }], error: null },
      horses: { data: [], error: null },
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByTestId("browse-filter")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Show following" }));

    await waitFor(() => {
      expect(screen.getByText("None of the horses you follow are available right now.")).toBeInTheDocument();
    });
    expect(screen.queryByText("You’re not following any horses yet.")).not.toBeInTheDocument();
  });

  it("does not render the pills before the subscription gate resolves", () => {
    mockTables({});
    // Synchronously, on first paint: `gated` is still its initial `false`, so a
    // naive `!gated` would flash the pills at a member who is about to be
    // walled. Asserted WITHOUT waitFor on purpose — the settled state is
    // covered by the access-wall test below.
    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    expect(screen.queryByTestId("browse-filter")).not.toBeInTheDocument();
  });

  it("switching filters clears the previous roster instead of showing a stale one", async () => {
    // Hold the follow read open so we can observe the in-flight frame.
    let releaseFollow: (v: { data: unknown; error: unknown }) => void = () => {};
    const followGate = new Promise<{ data: unknown; error: unknown }>((resolve) => {
      releaseFollow = resolve;
    });
    const horseChain = chainable({
      data: [{ id: "h-all", display_name: "Mahogany", racing_name: null, trainer: null }],
      error: null,
    });
    const followChain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "order", "limit", "range", "maybeSingle", "single"]) {
      followChain[m] = vi.fn(() => followChain);
    }
    followChain.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
      followGate.then(onF, onR);

    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return chainable(ENTITLED_SUB);
      if (table === "horse") return horseChain;
      if (table === "follow") return followChain;
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await waitFor(() => expect(screen.getByText("Mahogany")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Show following" }));

    // In flight: the Following pill already reads pressed, so the unfiltered
    // "All" roster must not still be on screen underneath it.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Show following" })).toHaveAttribute("aria-pressed", "true");
    });
    expect(screen.queryByText("Mahogany")).not.toBeInTheDocument();

    releaseFollow({ data: [], error: null });
    await waitFor(() => {
      expect(screen.getByText("You’re not following any horses yet.")).toBeInTheDocument();
    });
  });

  it("the pills are hidden behind the access wall", async () => {
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") {
        return chainable({ data: { status: "canceled", trial_ends_at: null, current_period_end: null }, error: null });
      }
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed />);

    await waitFor(() => {
      expect(screen.queryByTestId("browse-filter")).not.toBeInTheDocument();
    });
  });
});
