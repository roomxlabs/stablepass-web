import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mirrors test/follow-notify.test.tsx (the horse version) but for the trainer-level
// Follow/Notify: the target column is `trainer_id`, not `horse_id`.
const { insertMock, deleteCalls } = vi.hoisted(() => ({
  insertMock: vi.fn(async (_table: string, _row: unknown) => ({ error: null })),
  deleteCalls: [] as Array<{ table: string; eqs: Array<[string, unknown]> }>,
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    from: (table: string) => ({
      insert: (row: unknown) => insertMock(table, row),
      delete: () => {
        const record = { table, eqs: [] as Array<[string, unknown]> };
        deleteCalls.push(record);
        const chain = {
          eq: (col: string, val: unknown) => {
            record.eqs.push([col, val]);
            return chain;
          },
          then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
        };
        return chain;
      },
    }),
  }),
}));

import { FollowNotify } from "@/app/(member)/trainers/[id]/follow-notify";

describe("Trainer FollowNotify", () => {
  beforeEach(() => {
    insertMock.mockClear();
    deleteCalls.length = 0;
  });

  it("clicking Follow inserts a follow row {user_id, trainer_id} when not already following", async () => {
    const user = userEvent.setup();
    render(<FollowNotify trainerId="t1" userId="u1" initialFollowing={false} initialNotify={false} />);

    await user.click(screen.getByRole("button", { name: /^follow$/i }));

    expect(insertMock).toHaveBeenCalledWith("follow", { user_id: "u1", trainer_id: "t1" });
    expect(await screen.findByRole("button", { name: /^following$/i })).toBeInTheDocument();
  });

  it("clicking Follow deletes the follow row scoped to {user_id, trainer_id} when already following", async () => {
    const user = userEvent.setup();
    render(<FollowNotify trainerId="t1" userId="u1" initialFollowing initialNotify={false} />);

    await user.click(screen.getByRole("button", { name: /^following$/i }));

    const call = deleteCalls.find((c) => c.table === "follow");
    expect(call).toBeTruthy();
    expect(Object.fromEntries(call!.eqs)).toEqual({ user_id: "u1", trainer_id: "t1" });
  });

  it("clicking Notify inserts a notify_optin row {user_id, trainer_id} (trainer-level)", async () => {
    const user = userEvent.setup();
    render(<FollowNotify trainerId="t1" userId="u1" initialFollowing={false} initialNotify={false} />);

    await user.click(screen.getByRole("button", { name: /^notify$/i }));

    expect(insertMock).toHaveBeenCalledWith("notify_optin", { user_id: "u1", trainer_id: "t1" });
    expect(await screen.findByRole("button", { name: /^notify on$/i })).toBeInTheDocument();
  });

  it("clicking Notify when already opted in deletes the notify_optin row scoped to {user_id, trainer_id}", async () => {
    const user = userEvent.setup();
    render(<FollowNotify trainerId="t1" userId="u1" initialFollowing={false} initialNotify />);

    await user.click(screen.getByRole("button", { name: /^notify on$/i }));

    const call = deleteCalls.find((c) => c.table === "notify_optin");
    expect(call).toBeTruthy();
    expect(Object.fromEntries(call!.eqs)).toEqual({ user_id: "u1", trainer_id: "t1" });
  });
});
