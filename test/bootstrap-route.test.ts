import { describe, it, expect, vi, beforeEach } from "vitest";

const getUserMock = vi.fn();
const maybeSingleMock = vi.fn();

const chain: { select: ReturnType<typeof vi.fn>; eq: ReturnType<typeof vi.fn>; maybeSingle: ReturnType<typeof vi.fn> } = {
  select: vi.fn(),
  eq: vi.fn(),
  maybeSingle: maybeSingleMock,
};
chain.select.mockImplementation(() => chain);
chain.eq.mockImplementation(() => chain);
const fromMock = vi.fn(() => chain);

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
  })),
}));

import { POST } from "@/app/api/auth/bootstrap/route";

describe("POST /api/auth/bootstrap", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    maybeSingleMock.mockReset();
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 200 with the subscriber + subscription envelope when signed in", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    maybeSingleMock
      .mockResolvedValueOnce({ data: { id: "user-1", name: "Jo", email: "jo@example.com" } })
      .mockResolvedValueOnce({ data: { status: "trial", trial_ends_at: "2026-08-01" } });

    const res = await POST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.subscriber).toEqual({ id: "user-1", name: "Jo", email: "jo@example.com" });
    expect(body.data.subscription).toEqual({ status: "trial", trial_ends_at: "2026-08-01" });
  });
});
