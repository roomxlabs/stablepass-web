import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { HorsesGrid } from "@/app/(member)/horses/horses-grid";
import { TrainersGrid } from "@/app/(member)/trainers/trainers-grid";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";

function chainable(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "not", "order", "range", "maybeSingle", "single"]) {
    obj[method] = vi.fn(() => obj);
  }
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({ from: fromMock }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

describe("ENG-831 browse segregation — Horses / Trainers", () => {
  beforeEach(() => {
    fromMock.mockReset();
  });

  it("Horses browse filters shares_for_sale=false so for-sale horses never leak", async () => {
    const horseChain = chainable({
      data: [{ id: "h-ok", display_name: "Mahogany", racing_name: null, trainer: { name: "Waller" } }],
      error: null,
    });
    const subChain = chainable({
      data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null },
      error: null,
    });
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return subChain;
      if (table === "horse") return horseChain;
      return chainable({ data: null, error: null });
    });

    render(<HorsesGrid viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => {
      expect(screen.getByText("Mahogany")).toBeInTheDocument();
    });

    expect(horseChain.eq).toHaveBeenCalledWith("status", "active");
    expect(horseChain.eq).toHaveBeenCalledWith("shares_for_sale", false);
  });

  it("Trainers browse counts only non-sale horses", async () => {
    const trainerChain = chainable({
      data: [
        {
          id: "t1",
          name: "Chris Waller",
          display_name: null,
          stable_name: "Waller Racing",
          location: "Warwick Farm",
          horses: [
            { id: "h1", shares_for_sale: false },
            { id: "h2", shares_for_sale: true },
            { id: "h3", shares_for_sale: false },
          ],
        },
      ],
      error: null,
    });
    const subChain = chainable({
      data: { status: "trial", trial_ends_at: "2099-01-01T00:00:00Z", current_period_end: null },
      error: null,
    });
    fromMock.mockImplementation((table: string) => {
      if (table === "subscription") return subChain;
      if (table === "trainer") return trainerChain;
      return chainable({ data: null, error: null });
    });

    render(<TrainersGrid viewerId={VIEWER_ID} everSubscribed={false} />);

    await waitFor(() => {
      expect(screen.getByText("Chris Waller")).toBeInTheDocument();
    });
    // 2 non-sale horses — the for-sale one must not inflate the count.
    expect(screen.getByText("2 horses")).toBeInTheDocument();
    expect(trainerChain.select).toHaveBeenCalledWith(
      "id, name, display_name, stable_name, location, horses:horse!trainer_id(id, shares_for_sale)",
    );
  });
});
