import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocks the `stripe` SDK itself (not just our lib/stripe.ts wrapper) so the
// lazy-init helper (getStripe) is exercised for real: `new Stripe(key)` only
// happens when STRIPE_SECRET_KEY is set, mirroring the module-scope-throw fix.
// Also mocks supabaseServer with the same chainable query-builder stub used by
// me-route.test.ts (select/update/eq return itself; single() resolves a
// per-table fixture; updateMock records the exact patch passed to `.update`).
const { getUserMock, fromMock, updateMock, tableData, stripeMocks, StripeCtor } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const updateMock = vi.fn();
  const tableData: Record<string, { data: unknown; error?: unknown }> = {};

  function makeChain(table: string) {
    const result = () => tableData[table] ?? { data: null, error: null };
    const chain: {
      select: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      single: ReturnType<typeof vi.fn>;
    } = {
      select: vi.fn(),
      eq: vi.fn(),
      update: vi.fn(),
      single: vi.fn(async () => result()),
    };
    chain.select.mockImplementation(() => chain);
    chain.eq.mockImplementation(() => chain);
    chain.update.mockImplementation((patch: unknown) => {
      updateMock(table, patch);
      return chain;
    });
    return chain;
  }

  const fromMock = vi.fn((table: string) => makeChain(table));

  const stripeMocks = {
    customersCreate: vi.fn(),
    subscriptionsCreate: vi.fn(),
    subscriptionsUpdate: vi.fn(),
    setupIntentsCreate: vi.fn(),
  };

  // A regular `function` (not an arrow) — `new Stripe(key)` in lib/stripe.ts
  // requires a constructable mock; arrow functions can't be called with `new`.
  const StripeCtor = vi.fn().mockImplementation(function StripeMock() {
    return {
      customers: { create: stripeMocks.customersCreate },
      subscriptions: { create: stripeMocks.subscriptionsCreate, update: stripeMocks.subscriptionsUpdate },
      setupIntents: { create: stripeMocks.setupIntentsCreate },
    };
  });

  return { getUserMock, fromMock, updateMock, tableData, stripeMocks, StripeCtor };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
  })),
}));

vi.mock("stripe", () => ({
  default: StripeCtor,
}));

import { POST as checkoutPOST } from "@/app/api/subscription/checkout/route";
import { POST as cancelPOST } from "@/app/api/subscription/cancel/route";
import { POST as paymentMethodPOST } from "@/app/api/subscription/payment-method/route";

const USER = { id: "user-1", email: "member@stablepass.co" };
const ORIGINAL_ENV = process.env;

function resetAll() {
  getUserMock.mockReset();
  fromMock.mockClear();
  updateMock.mockClear();
  StripeCtor.mockClear();
  stripeMocks.customersCreate.mockReset();
  stripeMocks.subscriptionsCreate.mockReset();
  stripeMocks.subscriptionsUpdate.mockReset();
  stripeMocks.setupIntentsCreate.mockReset();
  for (const key of Object.keys(tableData)) delete tableData[key];
  process.env = { ...ORIGINAL_ENV, STRIPE_SECRET_KEY: "sk_test_dummy", STRIPE_PRICE_ID: "price_dummy" };
}

describe("POST /api/subscription/checkout", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 409 already_active when the subscription is already active", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "active", stripe_customer_id: "cus_1" } };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("already_active");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("returns 502 stripe_unavailable when STRIPE_SECRET_KEY is unset (no build-blocking module-scope init)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null } };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_unavailable");
    expect(StripeCtor).not.toHaveBeenCalled();
  });

  it("creates a Customer + incomplete Subscription with metadata.app_user_id and returns the clientSecret", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { payment_intent: { client_secret: "pi_new_secret" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.clientSecret).toBe("pi_new_secret");
    expect(body.data.subscriptionId).toBe("sub_new");

    expect(stripeMocks.customersCreate).toHaveBeenCalledWith(
      expect.objectContaining({ email: USER.email, metadata: { app_user_id: USER.id } }),
    );

    const createCall = stripeMocks.subscriptionsCreate.mock.calls[0][0];
    expect(createCall.customer).toBe("cus_new");
    expect(createCall.metadata).toEqual({ app_user_id: USER.id });
    expect(createCall.payment_behavior).toBe("default_incomplete");

    const updateCall = updateMock.mock.calls.find((c) => c[0] === "subscription");
    expect(updateCall).toBeTruthy();
    expect(updateCall![1]).toEqual({ stripe_customer_id: "cus_new", stripe_subscription_id: "sub_new" });
  });

  it("reuses an existing stripe_customer_id instead of creating a new Customer", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: "cus_existing" } };
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { payment_intent: { client_secret: "pi_new_secret" } },
    });

    const res = await checkoutPOST();

    expect(res.status).toBe(200);
    expect(stripeMocks.customersCreate).not.toHaveBeenCalled();
    expect(stripeMocks.subscriptionsCreate.mock.calls[0][0].customer).toBe("cus_existing");
  });

  it("returns 502 stripe_unavailable when Stripe throws", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: "cus_existing" } };
    stripeMocks.subscriptionsCreate.mockRejectedValue(new Error("stripe boom"));

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_unavailable");
  });
});

describe("POST /api/subscription/cancel", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await cancelPOST();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 409 not_active when the subscription isn't active", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_subscription_id: null, current_period_end: null } };

    const res = await cancelPOST();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("not_active");
    expect(stripeMocks.subscriptionsUpdate).not.toHaveBeenCalled();
  });

  it("returns 502 stripe_unavailable when STRIPE_SECRET_KEY is unset", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = {
      data: { status: "active", stripe_subscription_id: "sub_1", current_period_end: "2026-08-01T00:00:00.000Z" },
    };

    const res = await cancelPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_unavailable");
  });

  it("cancels at period end and returns {status:'canceled', currentPeriodEnd}", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = {
      data: { status: "active", stripe_subscription_id: "sub_1", current_period_end: "2026-08-01T00:00:00.000Z" },
    };
    stripeMocks.subscriptionsUpdate.mockResolvedValue({ id: "sub_1", cancel_at_period_end: true });

    const res = await cancelPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ status: "canceled", currentPeriodEnd: "2026-08-01T00:00:00.000Z" });
    expect(stripeMocks.subscriptionsUpdate).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
  });
});

describe("POST /api/subscription/payment-method", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await paymentMethodPOST();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 502 stripe_unavailable when STRIPE_SECRET_KEY is unset", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { stripe_customer_id: "cus_1" } };

    const res = await paymentMethodPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_unavailable");
  });

  it("returns 200 with a clientSecret from a new SetupIntent", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { stripe_customer_id: "cus_1" } };
    stripeMocks.setupIntentsCreate.mockResolvedValue({ client_secret: "seti_new_secret" });

    const res = await paymentMethodPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.clientSecret).toBe("seti_new_secret");
    expect(stripeMocks.setupIntentsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_1", metadata: { app_user_id: USER.id } }),
    );
  });
});
