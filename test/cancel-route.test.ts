import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/subscription/cancel — the member's "I'm done" control (ENG-1002).
//
// The route MUST go through `cancel_own_subscription()` (a SECURITY DEFINER
// RPC) and MUST NEVER `.from("subscription").update()` — a direct update from
// this route's RLS-scoped client matches ZERO ROWS under RLS and returns NO
// ERROR, which is exactly the ENG-582 checkout-route bug on this same table.
// The `from` spy below exists so that guardrail is a machine-checked fact,
// not a comment.
const { getUserMock, rpcMock, fromMock } = vi.hoisted(() => ({
  getUserMock: vi.fn(),
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    rpc: rpcMock,
    from: fromMock,
  })),
}));

import { POST } from "@/app/api/subscription/cancel/route";

function req(body?: unknown, opts?: { noBody?: boolean }) {
  return new Request("http://localhost/api/subscription/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(opts?.noBody ? {} : { body: JSON.stringify(body) }),
  });
}

const HAPPY_RPC_ROW = {
  status: "canceled",
  canceled_at: "2026-09-06T01:00:00Z",
  current_period_end: "2026-09-20T00:00:00Z",
  cancel_reason: "too pricey",
  stripe_customer_id: "cus_1",
  promo_passes_used: 3,
};

describe("POST /api/subscription/cancel", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    rpcMock.mockReset();
    fromMock.mockClear();
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
  });

  it("happy path — 200 with only status/canceledAt/currentPeriodEnd, never the untrusted/internal fields", async () => {
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });

    const res = await POST(req({ reason: "too pricey" }));
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    expect(res.status).toBe(200);
    expect(body).toEqual({
      data: {
        status: "canceled",
        canceledAt: "2026-09-06T01:00:00Z",
        currentPeriodEnd: "2026-09-20T00:00:00Z",
      },
    });
    expect(bodyText).not.toContain("too pricey");
    expect(bodyText).not.toContain("cus_1");
    expect(bodyText).not.toContain("promo_passes_used");
  });

  // GUARDRAIL (ENG-582 on this same table): the route calls the RPC and never
  // a table update. A direct `.from("subscription").update()` under RLS
  // matches zero rows and returns no error — it would look like success while
  // writing nothing. Also pins that no user id crosses into the call: the
  // definer function self-scopes with `auth.uid()`, and a definer function
  // that accepted an id parameter would let any member cancel anyone's row.
  it("GUARDRAIL — calls only the RPC (never .from().update()), and passes no user id", async () => {
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });

    await POST(req({ reason: "too pricey" }));

    expect(rpcMock).toHaveBeenCalledWith("cancel_own_subscription", { p_reason: "too pricey" });
    expect(fromMock).not.toHaveBeenCalled();
    const [, args] = rpcMock.mock.calls[0]!;
    expect(Object.keys(args as Record<string, unknown>)).toEqual(["p_reason"]);
  });

  it("401 when there is no session, and the RPC is never called", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await POST(req({}));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  // Covers BOTH an already-cancelled row and a lapsed one — the RPC raises
  // 42501 indistinguishably for either, and both must surface as 409, not
  // 500 and not PostgREST's own 403.
  it("409 no_active_subscription — double-cancel or a lapsed row (RPC 42501), not 500/403", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "42501", message: "no_active_subscription" } });

    const res = await POST(req({}));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("no_active_subscription");
  });

  it("400 validation_failed for a reason over the 500-char limit, and nothing is written", async () => {
    const res = await POST(req({ reason: "a".repeat(501) }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("a reason of exactly 500 chars is NOT rejected", async () => {
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });
    const reason = "a".repeat(500);

    const res = await POST(req({ reason }));

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("cancel_own_subscription", { p_reason: reason });
  });

  it("trims the reason before sending it to the RPC", async () => {
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });

    await POST(req({ reason: "  too pricey  " }));

    expect(rpcMock).toHaveBeenCalledWith("cancel_own_subscription", { p_reason: "too pricey" });
  });

  it("a whitespace-only reason is sent as p_reason: null", async () => {
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });

    const res = await POST(req({ reason: "   \n\t " }));

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("cancel_own_subscription", { p_reason: null });
  });

  it("no reason key at all -> p_reason: null, 200", async () => {
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });

    const res = await POST(req({}));

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("cancel_own_subscription", { p_reason: null });
  });

  it("no body at all / unparseable body -> p_reason: null, 200", async () => {
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });

    const res = await POST(req(undefined, { noBody: true }));

    expect(res.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("cancel_own_subscription", { p_reason: null });
  });

  it("a non-string reason is validation_failed, and the RPC is never called", async () => {
    const res = await POST(req({ reason: 42 }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("validation_failed");
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("an unknown RPC error surfaces as 500 cancel_failed and never leaks the raw error.message", async () => {
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "23514", message: "cancel_reason violates check constraint on offending row" },
    });

    const res = await POST(req({}));
    const bodyText = await res.text();
    const body = JSON.parse(bodyText);

    expect(res.status).toBe(500);
    expect(body.error.code).toBe("cancel_failed");
    expect(bodyText).not.toContain("offending row");
    expect(bodyText).not.toContain("cancel_reason violates");
  });
});
