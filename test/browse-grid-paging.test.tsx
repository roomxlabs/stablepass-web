import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HorsesGrid, HORSES_PAGE_SIZE } from "@/app/(member)/horses/horses-grid";
import { TrainersGrid, TRAINERS_PAGE_SIZE } from "@/app/(member)/trainers/trainers-grid";

// Both browse grids used to select their WHOLE table client-side — every active
// horse with an embedded trainer join, every active trainer with every one of
// their horses. These tests pin the fix: a bounded first `.range`, a total order
// (`name`/`display_name` THEN `id`, so a tie can't shuffle a row across the page
// boundary), and a "Show more" that asks for the NEXT window rather than
// re-reading the table.

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

const ENTITLED = { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null };

/** A PostgREST-ish chain whose terminal value is decided per `.range(...)` call. */
function pagedChain(pages: Record<number, unknown[]>) {
  const calls: [number, number][] = [];
  let pending: unknown[] = [];
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order", "maybeSingle", "single"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.range = vi.fn((from: number, to: number) => {
    calls.push([from, to]);
    pending = pages[from] ?? [];
    return obj;
  });
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve({ data: pending, error: null }).then(onFulfilled, onRejected);
  obj.rangeCalls = calls;
  return obj as typeof obj & { rangeCalls: [number, number][]; order: ReturnType<typeof vi.fn>; range: ReturnType<typeof vi.fn> };
}

function subChain() {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "range"]) obj[method] = vi.fn(() => obj);
  obj.maybeSingle = vi.fn(async () => ({ data: ENTITLED, error: null }));
  return obj;
}

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ from: fromMock }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

function horseRows(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `h${from + i}`,
    display_name: `Horse ${String(from + i).padStart(3, "0")}`,
    racing_name: null,
    trainer: { name: "Waller" },
  }));
}

function trainerRows(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${from + i}`,
    name: `Trainer ${String(from + i).padStart(3, "0")}`,
    display_name: null,
    stable_name: null,
    location: null,
    horses: [],
  }));
}

beforeEach(() => {
  fromMock.mockReset();
});

describe("HorsesGrid paging", () => {
  it("asks for one bounded page in a total order, not the whole table", async () => {
    const horse = pagedChain({ 0: horseRows(0, 3) });
    fromMock.mockImplementation((table: string) => (table === "subscription" ? subChain() : horse));

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Horse 000");

    expect(horse.rangeCalls).toEqual([[0, HORSES_PAGE_SIZE - 1]]);
    // `display_name` alone is not a total order — `id` breaks the ties so two
    // adjacent `.range` windows can never drop or duplicate a row.
    expect(horse.order).toHaveBeenCalledWith("display_name");
    expect(horse.order).toHaveBeenCalledWith("id");
  });

  it("hides Show more when the first page is short", async () => {
    const horse = pagedChain({ 0: horseRows(0, 3) });
    fromMock.mockImplementation((table: string) => (table === "subscription" ? subChain() : horse));

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Horse 000");

    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
  });

  it("Show more fetches the NEXT range and appends it", async () => {
    const horse = pagedChain({
      0: horseRows(0, HORSES_PAGE_SIZE),
      [HORSES_PAGE_SIZE]: horseRows(HORSES_PAGE_SIZE, 5),
    });
    fromMock.mockImplementation((table: string) => (table === "subscription" ? subChain() : horse));

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Horse 000");

    const more = await screen.findByRole("button", { name: /show more/i });
    await userEvent.click(more);

    await waitFor(() => {
      expect(screen.getByText(`Horse ${String(HORSES_PAGE_SIZE).padStart(3, "0")}`)).toBeInTheDocument();
    });
    // The first page is still on screen — appended, not replaced.
    expect(screen.getByText("Horse 000")).toBeInTheDocument();
    expect(horse.rangeCalls).toEqual([
      [0, HORSES_PAGE_SIZE - 1],
      [HORSES_PAGE_SIZE, HORSES_PAGE_SIZE * 2 - 1],
    ]);
    // The short second page ends the list.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
    });
  });
});

describe("TrainersGrid paging", () => {
  it("asks for one bounded page in a total order, not the whole table", async () => {
    const trainer = pagedChain({ 0: trainerRows(0, 3) });
    fromMock.mockImplementation((table: string) => (table === "subscription" ? subChain() : trainer));

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Trainer 000");

    expect(trainer.rangeCalls).toEqual([[0, TRAINERS_PAGE_SIZE - 1]]);
    expect(trainer.order).toHaveBeenCalledWith("name");
    expect(trainer.order).toHaveBeenCalledWith("id");
    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
  });

  it("Show more fetches the NEXT range and appends it", async () => {
    const trainer = pagedChain({
      0: trainerRows(0, TRAINERS_PAGE_SIZE),
      [TRAINERS_PAGE_SIZE]: trainerRows(TRAINERS_PAGE_SIZE, 2),
    });
    fromMock.mockImplementation((table: string) => (table === "subscription" ? subChain() : trainer));

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);
    await screen.findByText("Trainer 000");

    await userEvent.click(await screen.findByRole("button", { name: /show more/i }));

    await waitFor(() => {
      expect(screen.getByText(`Trainer ${String(TRAINERS_PAGE_SIZE).padStart(3, "0")}`)).toBeInTheDocument();
    });
    expect(screen.getByText("Trainer 000")).toBeInTheDocument();
    expect(trainer.rangeCalls).toEqual([
      [0, TRAINERS_PAGE_SIZE - 1],
      [TRAINERS_PAGE_SIZE, TRAINERS_PAGE_SIZE * 2 - 1],
    ]);
  });
});
