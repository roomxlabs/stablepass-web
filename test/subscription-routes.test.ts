import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocks the `stripe` SDK itself (not just our lib/stripe.ts wrapper) so the
// lazy-init helper (getStripe) is exercised for real: `new Stripe(key)` only
// happens when STRIPE_SECRET_KEY is set, mirroring the module-scope-throw fix.
// Also mocks supabaseServer with the same chainable query-builder stub used by
// me-route.test.ts (select/update/eq return itself; single()/maybeSingle()
// each resolve a per-table fixture; updateMock records the exact patch passed
// to `.update`).
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
      maybeSingle: ReturnType<typeof vi.fn>;
    } = {
      select: vi.fn(),
      eq: vi.fn(),
      update: vi.fn(),
      single: vi.fn(async () => result()),
      maybeSingle: vi.fn(async () => result()),
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
    pricesRetrieve: vi.fn(),
    customersCreate: vi.fn(),
    customersUpdate: vi.fn(),
    subscriptionsCreate: vi.fn(),
    paymentIntentsCreate: vi.fn(),
  };

  // A regular `function` (not an arrow) — `new Stripe(key)` in lib/stripe.ts
  // requires a constructable mock; arrow functions can't be called with `new`.
  const StripeCtor = vi.fn().mockImplementation(function StripeMock() {
    return {
      prices: { retrieve: stripeMocks.pricesRetrieve },
      customers: { create: stripeMocks.customersCreate, update: stripeMocks.customersUpdate },
      subscriptions: { create: stripeMocks.subscriptionsCreate },
      paymentIntents: { create: stripeMocks.paymentIntentsCreate },
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

const USER = { id: "user-1", email: "member@stablepass.co" };
const ORIGINAL_ENV = process.env;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function resetAll() {
  getUserMock.mockReset();
  fromMock.mockClear();
  updateMock.mockClear();
  StripeCtor.mockClear();
  stripeMocks.pricesRetrieve.mockReset();
  stripeMocks.customersCreate.mockReset();
  stripeMocks.customersUpdate.mockReset();
  stripeMocks.subscriptionsCreate.mockReset();
  stripeMocks.paymentIntentsCreate.mockReset();
  for (const key of Object.keys(tableData)) delete tableData[key];
  // The publishable key must be set for a fully-configured Stripe: it is
  // `undefined` otherwise, and an undefined value is DROPPED by JSON
  // serialisation — so the response would silently ship without the key the
  // screen needs to mount Elements at all.
  process.env = {
    ...ORIGINAL_ENV,
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_PRICE_ID: "price_dummy",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_dummy",
  };
  // Nearly every test needs a resolvable price — default it here.
  stripeMocks.pricesRetrieve.mockResolvedValue({ unit_amount: 1900, currency: "aud" });
}

describe("POST /api/subscription/checkout", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("returns 401 with the error envelope when there is no session", async () => {
    getUserMock.mockResolvedValue({ data: { user: null } });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 502 stripe_unavailable when STRIPE_SECRET_KEY is unset (no build-blocking module-scope init)", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_unavailable");
    expect(StripeCtor).not.toHaveBeenCalled();
  });

  it("non-active member: creates a pre-cancelled incomplete Subscription and returns mode:'purchase'", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    // Mirrors Stripe at API version 2026-06-24.dahlia: `latest_invoice.payment_intent`
    // no longer exists — the client secret lives at `confirmation_secret` instead.
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.mode).toBe("purchase");
    expect(body.data.clientSecret).toBe("pi_new_secret");

    const createCall = stripeMocks.subscriptionsCreate.mock.calls[0][0];
    expect(createCall.cancel_at_period_end).toBe(true);
    expect(createCall.metadata).toEqual({ app_user_id: "user-1" });
    expect(createCall.payment_behavior).toBe("default_incomplete");
  });

  it("expands latest_invoice.confirmation_secret — the legacy payment_intent path alone yields no secret at 2026-06-24.dahlia", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();

    const expandArg = stripeMocks.subscriptionsCreate.mock.calls[0][0].expand;
    expect(expandArg).toContain("latest_invoice.confirmation_secret");
    // Kept as a cross-version fallback for an account pinned to an older API version.
    expect(expandArg).toContain("latest_invoice.payment_intent");
  });

  it("new shape only (no payment_intent key): still returns a usable clientSecret", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_conf_secret" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.clientSecret).toBe("pi_conf_secret");
  });

  it("legacy shape only: the payment_intent fallback still resolves (older pinned API version)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { payment_intent: { client_secret: "pi_legacy_secret" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.clientSecret).toBe("pi_legacy_secret");
  });

  it("confirmation_secret wins over a legacy payment_intent when both are present", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: {
        confirmation_secret: { type: "payment_intent", client_secret: "pi_conf_secret" },
        payment_intent: { client_secret: "pi_legacy_secret" },
      },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.clientSecret).toBe("pi_conf_secret");
  });

  it("neither shape present: returns a null clientSecret AND logs loudly (never silently dead)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: {},
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.clientSecret).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  // confirmation_secret is a TAGGED union. A $0 invoice (100%-off coupon, credit
  // balance) yields a SetupIntent secret; handing a `seti_…` to Elements as a
  // payment secret fails at confirmPayment, so it must not be accepted.
  it("confirmation_secret of type setup_intent is REJECTED, not handed to Elements as a payment secret", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "setup_intent", client_secret: "seti_x_secret_y" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.clientSecret).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("an empty-string client_secret normalises to null rather than serialising an empty string", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(body.data.clientSecret).toBeNull();

    consoleErrorSpy.mockRestore();
  });

  it("customer identity: builds name + address from app_user when no stripe_customer_id exists", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    tableData.app_user = { data: { first_name: "Jane", last_name: "Doe", postcode: "3000" } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();

    expect(stripeMocks.customersCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Jane Doe",
        address: { postal_code: "3000", country: "AU" },
        metadata: { app_user_id: "user-1" },
      }),
    );
  });

  it("null postcode: omits postal_code entirely instead of sending an empty string", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    tableData.app_user = { data: { first_name: "Jane", last_name: "Doe", postcode: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();

    const addressArg = stripeMocks.customersCreate.mock.calls[0][0].address;
    expect(addressArg).not.toHaveProperty("postal_code");
    expect(addressArg.country).toBe("AU");
  });

  it("existing stripe_customer_id: updates the Customer instead of creating a new one", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: "cus_existing", current_period_end: null } };
    tableData.app_user = { data: { first_name: "Jane", last_name: "Doe", postcode: "3000" } };
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();

    expect(stripeMocks.customersCreate).not.toHaveBeenCalled();
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith(
      "cus_existing",
      expect.objectContaining({ name: "Jane Doe", address: { postal_code: "3000", country: "AU" } }),
    );
  });

  it("active member: early renewal via a one-off PaymentIntent, not a new Subscription", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    const futureEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    tableData.subscription = {
      data: { status: "active", stripe_customer_id: "cus_existing", current_period_end: futureEnd },
    };
    stripeMocks.paymentIntentsCreate.mockResolvedValue({ client_secret: "pi_renew_secret" });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(body.data.mode).toBe("renewal");

    const intentArg = stripeMocks.paymentIntentsCreate.mock.calls[0][0];
    expect(intentArg.metadata.app_user_id).toBe("user-1");
    expect(intentArg.metadata.kind).toBe("renewal");
    expect(typeof intentArg.metadata.new_period_end).toBe("string");
  });

  it("renewal new_period_end is computed from current_period_end, not from now", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const currentEndMs = now.getTime() + 10 * 24 * 60 * 60 * 1000;
    tableData.subscription = {
      data: {
        status: "active",
        stripe_customer_id: "cus_existing",
        current_period_end: new Date(currentEndMs).toISOString(),
      },
    };
    stripeMocks.paymentIntentsCreate.mockResolvedValue({ client_secret: "pi_renew_secret" });

    await checkoutPOST();

    const intentArg = stripeMocks.paymentIntentsCreate.mock.calls[0][0];
    const actual = parseInt(intentArg.metadata.new_period_end, 10);
    const expectedFromCurrentEnd = Math.floor((currentEndMs + THIRTY_DAYS_MS) / 1000);
    const wrongFromNow = Math.floor((now.getTime() + THIRTY_DAYS_MS) / 1000);

    expect(actual).toBe(expectedFromCurrentEnd);
    expect(Math.abs(actual - wrongFromNow)).toBeGreaterThan(5);
  });

  it("renewal with null current_period_end falls back to now", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    const now = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    tableData.subscription = {
      data: { status: "active", stripe_customer_id: "cus_existing", current_period_end: null },
    };
    stripeMocks.paymentIntentsCreate.mockResolvedValue({ client_secret: "pi_renew_secret" });

    await checkoutPOST();

    const intentArg = stripeMocks.paymentIntentsCreate.mock.calls[0][0];
    const actual = parseInt(intentArg.metadata.new_period_end, 10);
    const expected = Math.floor((now.getTime() + THIRTY_DAYS_MS) / 1000);

    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2);
  });

  it("renewal PaymentIntent amount/currency come from the retrieved price, not a literal", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    stripeMocks.pricesRetrieve.mockResolvedValue({ unit_amount: 100, currency: "aud" });
    const futureEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    tableData.subscription = {
      data: { status: "active", stripe_customer_id: "cus_existing", current_period_end: futureEnd },
    };
    stripeMocks.paymentIntentsCreate.mockResolvedValue({ client_secret: "pi_renew_secret" });

    await checkoutPOST();

    const intentArg = stripeMocks.paymentIntentsCreate.mock.calls[0][0];
    expect(intentArg.amount).toBe(100);
    expect(intentArg.currency).toBe("aud");
  });

  it("prices.retrieve rejecting returns 502 stripe_error (NOT stripe_unavailable — the key is fine)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    stripeMocks.pricesRetrieve.mockRejectedValue(new Error("stripe down"));
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    // ENG-581: a working key that Stripe rejected is NOT a configuration
    // problem. Sharing `stripe_unavailable` here is what made the screen tell a
    // correctly-configured operator their key was missing.
    expect(body.error.code).toBe("stripe_error");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("prices.retrieve resolving a null unit_amount returns 502 stripe_error without charging", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    stripeMocks.pricesRetrieve.mockResolvedValue({ unit_amount: null, currency: "aud" });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("both branches echo unitAmount and currency in the body alongside clientSecret", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    stripeMocks.pricesRetrieve.mockResolvedValue({ unit_amount: 1900, currency: "aud" });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    const purchaseRes = await checkoutPOST();
    const purchaseBody = await purchaseRes.json();
    expect(purchaseBody.data.unitAmount).toBe(1900);
    expect(purchaseBody.data.currency).toBe("aud");
    expect(purchaseBody.data.clientSecret).toBe("pi_new_secret");

    const futureEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    tableData.subscription = {
      data: { status: "active", stripe_customer_id: "cus_existing", current_period_end: futureEnd },
    };
    stripeMocks.paymentIntentsCreate.mockResolvedValue({ client_secret: "pi_renew_secret" });

    const renewalRes = await checkoutPOST();
    const renewalBody = await renewalRes.json();
    expect(renewalBody.data.unitAmount).toBe(1900);
    expect(renewalBody.data.currency).toBe("aud");
    expect(renewalBody.data.clientSecret).toBe("pi_renew_secret");
  });

  it("returns 502 stripe_error when Stripe throws creating the Subscription", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: "cus_existing", current_period_end: null } };
    stripeMocks.subscriptionsCreate.mockRejectedValue(new Error("stripe boom"));

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
  });

  // CONTRACT: pins the exact key set the screen destructures. Renaming any of
  // these in the route (publishableKey especially) otherwise keeps every test
  // green while breaking the real screen — `publishableKey` going missing makes
  // CheckoutForm fall to the disabled placeholder forever, i.e. NOBODY CAN PAY.
  // A key-set assertion, not per-field, is what makes a rename impossible.
  it("CONTRACT: the purchase response carries exactly the keys the screen reads", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: "cus_existing", current_period_end: null } };
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    const body = await (await checkoutPOST()).json();

    expect(Object.keys(body.data).sort()).toEqual(
      ["clientSecret", "currency", "mode", "publishableKey", "subscriptionId", "unitAmount"].sort(),
    );
    expect(body.data.mode).toBe("purchase");
  });

  it("CONTRACT: the renewal response carries exactly the keys the screen reads (incl. both dates)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = {
      data: {
        status: "active",
        stripe_customer_id: "cus_existing",
        current_period_end: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      },
    };
    stripeMocks.paymentIntentsCreate.mockResolvedValue({ client_secret: "pi_renew_secret" });

    const body = await (await checkoutPOST()).json();

    expect(Object.keys(body.data).sort()).toEqual(
      ["clientSecret", "currency", "currentPeriodEnd", "mode", "newPeriodEnd", "publishableKey", "unitAmount"].sort(),
    );
    expect(body.data.mode).toBe("renewal");
  });

  // The advance-only rule cuts BOTH ways. A late/failed webhook leaves an
  // `active` row whose current_period_end is already in the PAST; extending from
  // that stale date would hand the member fewer than 30 days (or none at all).
  it("renewal: a PAST current_period_end falls back to now — never extends from a stale date", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    const pastEnd = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    tableData.subscription = {
      data: { status: "active", stripe_customer_id: "cus_existing", current_period_end: pastEnd },
    };
    stripeMocks.paymentIntentsCreate.mockResolvedValue({ client_secret: "pi_renew_secret" });

    await checkoutPOST();

    const newPeriodEnd = Number(stripeMocks.paymentIntentsCreate.mock.calls[0][0].metadata.new_period_end);
    const expectedFromNow = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000);
    const staleFromPastEnd = Math.floor((Date.parse(pastEnd) + 30 * 24 * 60 * 60 * 1000) / 1000);

    expect(Math.abs(newPeriodEnd - expectedFromNow)).toBeLessThan(5);
    // The whole point: it must NOT have extended from the stale past date.
    expect(Math.abs(newPeriodEnd - staleFromPastEnd)).toBeGreaterThan(60);
  });

  // Stripe treats an address hash on UPDATE as a full replacement, so sending a
  // bare { country: "AU" } for a member with no postcode would silently destroy
  // the postal_code Stripe already holds — on every checkout POST.
  it("existing customer with no postcode: omits `address` entirely rather than wiping the stored one", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: "cus_existing", current_period_end: null } };
    tableData.app_user = { data: { first_name: "Jane", last_name: "Doe", postcode: null } };
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();

    const [id, patch] = stripeMocks.customersUpdate.mock.calls[0];
    expect(id).toBe("cus_existing");
    expect(patch).not.toHaveProperty("address");
    expect(patch.name).toBe("Jane Doe");
  });

  // GUARDRAIL (.rx/guardrails.md #3 — "content is subscription-gated"): the BFF
  // NEVER grants access. Only the be webhook may write `status`. If this route
  // could set status='active', a member could self-grant access by POSTing
  // checkout without ever paying. Asserted on the recorded update patches for
  // BOTH branches — previously the recorder existed but nothing checked it.
  it("GUARDRAIL: never writes `status` (let alone 'active') to the subscription table — only the webhook grants access", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });

    // Branch A — first purchase.
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    expect((await checkoutPOST()).status).toBe(200);

    // Branch B — early renewal.
    tableData.subscription = {
      data: {
        status: "active",
        stripe_customer_id: "cus_existing",
        current_period_end: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      },
    };
    stripeMocks.paymentIntentsCreate.mockResolvedValue({ client_secret: "pi_renew_secret" });

    expect((await checkoutPOST()).status).toBe(200);

    const subscriptionPatches = updateMock.mock.calls
      .filter((c) => c[0] === "subscription")
      .map((c) => c[1] as Record<string, unknown>);

    // The route must have written something (otherwise this test would pass vacuously).
    expect(subscriptionPatches.length).toBeGreaterThan(0);
    for (const patch of subscriptionPatches) {
      expect(patch).not.toHaveProperty("status");
      expect(patch).not.toHaveProperty("trial_ends_at");
      expect(patch).not.toHaveProperty("current_period_end");
      // Only Stripe identifiers may be persisted from the BFF.
      expect(Object.keys(patch).every((k) => k === "stripe_customer_id" || k === "stripe_subscription_id")).toBe(true);
    }
  });
});
