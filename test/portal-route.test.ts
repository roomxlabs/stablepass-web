import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getUserMock, fromMock, selectMock, tableData, getStripeMock, sessionsCreate } = vi.hoisted(
  () => {
    const tableData: Record<string, { data: unknown; error?: unknown }> = {};
    const selectMock = vi.fn();
    function makeChain(table: string) {
      const result = () => tableData[table] ?? { data: null, error: null };
      const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        update: vi.fn(),
        maybeSingle: vi.fn(async () => result()),
      };
      chain.select.mockImplementation((projection: unknown) => {
        selectMock(table, projection);
        return chain;
      });
      chain.eq.mockImplementation(() => chain);
      chain.update.mockImplementation(() => chain);
      return chain;
    }
    return {
      getUserMock: vi.fn(),
      fromMock: vi.fn((table: string) => makeChain(table)),
      selectMock,
      tableData,
      getStripeMock: vi.fn(),
      sessionsCreate: vi.fn(),
    };
  },
);

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
    rpc: vi.fn(),
  })),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: getStripeMock,
}));

import { GET } from "@/app/api/subscription/portal/route";

const ORIGINAL_ENV = process.env;

function req(headers?: Record<string, string>) {
  return new Request("http://localhost/api/subscription/portal", {
    method: "GET",
    headers: { host: "localhost:3000", ...headers },
  });
}

describe("GET /api/subscription/portal", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    fromMock.mockClear();
    selectMock.mockClear();
    sessionsCreate.mockReset();
    for (const key of Object.keys(tableData)) delete tableData[key];
    process.env = {
      ...ORIGINAL_ENV,
      STRIPE_SECRET_KEY: "sk_test_dummy",
      STRIPE_PORTAL_CONFIGURATION_ID: "bpc_test_pin",
    };
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    getStripeMock.mockReturnValue({
      billingPortal: { sessions: { create: sessionsCreate } },
    });
    sessionsCreate.mockResolvedValue({ url: "https://billing.stripe.com/session/test" });
    tableData.subscription = { data: { stripe_customer_id: "cus_1" } };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("302 to the portal URL and pins the configuration id + /account return_url", async () => {
    const res = await GET(req());

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://billing.stripe.com/session/test");
    expect(sessionsCreate).toHaveBeenCalledTimes(1);
    expect(sessionsCreate).toHaveBeenCalledWith({
      customer: "cus_1",
      return_url: "http://localhost:3000/account",
      configuration: "bpc_test_pin",
    });
    // SELECT only — a table write from this client is the ENG-582 silent no-op.
    const chain = fromMock.mock.results[0]?.value as { update: ReturnType<typeof vi.fn> };
    expect(chain.update).not.toHaveBeenCalled();
    expect(selectMock).toHaveBeenCalledWith("subscription", "stripe_customer_id");
  });

  it("401 when there is no session — Stripe is never called", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
    expect(sessionsCreate).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("409 no_stripe_customer when the member has never subscribed", async () => {
    tableData.subscription = { data: { stripe_customer_id: null } };

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("no_stripe_customer");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("409 when there is no subscription row at all", async () => {
    tableData.subscription = { data: null };

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("no_stripe_customer");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("502 stripe_unavailable when STRIPE_SECRET_KEY is unset (getStripe null)", async () => {
    getStripeMock.mockReturnValue(null);

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_unavailable");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("502 stripe_error when Stripe throws, and it is NOT stripe_unavailable", async () => {
    sessionsCreate.mockRejectedValue(new Error("portal_outage"));

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
    expect(body.error.code).not.toBe("stripe_unavailable");
  });

  it("GUARDRAIL — missing configuration id is 502 stripe_error and create is never called (no unpinned session)", async () => {
    delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });

  it("GUARDRAIL — a blank configuration id is treated as unset, not an unpinned session", async () => {
    process.env.STRIPE_PORTAL_CONFIGURATION_ID = "   ";

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});
