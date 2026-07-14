import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HorsePicker } from "@/app/onboarding/horse-picker";

const pushMock = vi.fn();
const refreshMock = vi.fn();
const insertMock = vi.fn().mockResolvedValue({ error: null });

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    from: () => ({ insert: insertMock }),
  }),
}));

const HORSES = [
  { id: "h1", name: "Mahogany", trainer: "Chris Waller" },
  { id: "h2", name: "Winx", trainer: "Chris Waller" },
  { id: "h3", name: "Black Caviar", trainer: "Peter Moody" },
];

describe("HorsePicker", () => {
  beforeEach(() => {
    pushMock.mockClear();
    refreshMock.mockClear();
    insertMock.mockClear();
  });

  it("gates Continue behind a minimum of 2 selections, then inserts one follow row per pick and navigates to /explore", async () => {
    const user = userEvent.setup();
    render(<HorsePicker horses={HORSES} userId="u1" />);

    const continueBtn = screen.getByRole("button", { name: /continue/i });
    expect(continueBtn).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /mahogany/i }));
    expect(continueBtn).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /winx/i }));
    expect(continueBtn).toBeEnabled();
    expect(screen.getByText(/2 selected/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByText(/3 selected/i)).toBeInTheDocument();

    await user.click(continueBtn);

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/explore"));

    expect(insertMock).toHaveBeenCalledTimes(1);
    const rows = insertMock.mock.calls[0][0] as Array<{ user_id: string; horse_id: string }>;
    expect(rows).toHaveLength(3);
    rows.forEach((row) => expect(row.user_id).toBe("u1"));
  });
});
