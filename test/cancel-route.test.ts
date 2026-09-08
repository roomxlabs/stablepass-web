import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/subscription/cancel — the member's "I'm done" control (ENG-1002).
//
// The route MUST go through `cancel_own_subscription()` (a SECURITY DEFINER
// RPC) and MUST NEVER `.from("subscription").update()` — a direct update from
// this route's RLS-scoped client matches ZERO ROWS under RLS and returns NO
// ERROR, which is exactly the ENG-582 checkout-route bug on this same table.
// The `from` spy below exists so that guardrail is a machine-checked fact,
// not a comment.
const { getUserMock, rpcMock, fromMock, updateMock, getStripeMock, subscriptionsUpdate, tableData } =
  vi.hoisted(() => {
    const tableData: Record<string, { data: unknown; error?: unknown }> = {};
    const updateMock = vi.fn();
    function makeChain(table: string) {
      const result = () => tableData[table] ?? { data: null, error: null };
      const chain = {
        select: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        update: vi.fn((patch: unknown) => {
          updateMock(table, patch);
          return chain;
        }),
        maybeSingle: vi.fn(async () => result()),
      };
      return chain;
    }
    return {
      getUserMock: vi.fn(),
      rpcMock: vi.fn(),
      fromMock: vi.fn((table: string) => makeChain(table)),
      updateMock,
      getStripeMock: vi.fn(),
      subscriptionsUpdate: vi.fn(),
      tableData,
    };
  });

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    rpc: rpcMock,
    from: fromMock,
  })),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: getStripeMock,
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
    updateMock.mockClear();
    subscriptionsUpdate.mockReset();
    for (const key of Object.keys(tableData)) delete tableData[key];
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    getStripeMock.mockReturnValue({ subscriptions: { update: subscriptionsUpdate } });
    subscriptionsUpdate.mockResolvedValue({ cancel_at_period_end: true });
    tableData.subscription = { data: { stripe_subscription_id: "sub_1" } };
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

  // GUARDRAIL (ENG-582 on this same table): the route may SELECT the Stripe
  // id but MUST NEVER `.from("subscription").update()`. A direct update under
  // RLS matches zero rows and returns no error — it would look like success
  // while writing nothing. Also pins that no user id crosses into the RPC:
  // the definer function self-scopes with `auth.uid()`.
  it("GUARDRAIL — writes only via the RPC (never .from().update()), and passes no user id", async () => {
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });

    await POST(req({ reason: "too pricey" }));

    expect(rpcMock).toHaveBeenCalledWith("cancel_own_subscription", { p_reason: "too pricey" });
    expect(updateMock).not.toHaveBeenCalled();
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
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
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

  it("calls Stripe cancel_at_period_end:true BEFORE the RPC", async () => {
    const order: string[] = [];
    subscriptionsUpdate.mockImplementation(async () => {
      order.push("stripe");
      return { cancel_at_period_end: true };
    });
    rpcMock.mockImplementation(async () => {
      order.push("rpc");
      return { data: HAPPY_RPC_ROW, error: null };
    });

    const res = await POST(req({}));

    expect(res.status).toBe(200);
    expect(order).toEqual(["stripe", "rpc"]);
    expect(subscriptionsUpdate).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
  });

  it("502 stripe_error when Stripe refuses — RPC is never called, row untouched", async () => {
    subscriptionsUpdate.mockRejectedValue(new Error("stripe_outage"));
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });

    const res = await POST(req({ reason: "too pricey" }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
    expect(rpcMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("502 stripe_error when the key is missing and a Stripe id exists — RPC is never called", async () => {
    getStripeMock.mockReturnValue(null);
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });

    const res = await POST(req({}));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
    expect(rpcMock).not.toHaveBeenCalled();
    expect(subscriptionsUpdate).not.toHaveBeenCalled();

    // A reused module-scope Response is unreadable on the second call.
    const again = await POST(req({}));
    expect(again.status).toBe(502);
    expect((await again.json()).error.code).toBe("stripe_error");
  });

  it("no stripe_subscription_id → skip Stripe and still run the RPC", async () => {
    tableData.subscription = { data: { stripe_subscription_id: null } };
    rpcMock.mockResolvedValue({ data: HAPPY_RPC_ROW, error: null });

    const res = await POST(req({}));

    expect(res.status).toBe(200);
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith("cancel_own_subscription", { p_reason: null });
  });

  it("a failed subscription read is 500 and touches neither Stripe nor the RPC", async () => {
    tableData.subscription = {
      data: null,
      error: { code: "42703", message: "column subscription.stripe_subscription_id does not exist" },
    };

    const res = await POST(req({}));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe("cancel_failed");
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("no subscription row → skip Stripe and still run the RPC (409 is the RPC's to report)", async () => {
    tableData.subscription = { data: null };
    rpcMock.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "no_active_subscription" },
    });

    const res = await POST(req({}));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("no_active_subscription");
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalled();
  });

  it("an over-long reason is 400 before Stripe OR the RPC is touched", async () => {
    const res = await POST(req({ reason: "a".repeat(501) }));

    expect(res.status).toBe(400);
    expect(subscriptionsUpdate).not.toHaveBeenCalled();
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
