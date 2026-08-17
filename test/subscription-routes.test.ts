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
    customersList: vi.fn(),
    customersSearch: vi.fn(),
    subscriptionsCreate: vi.fn(),
    subscriptionsList: vi.fn(),
    paymentIntentsCreate: vi.fn(),
  };

  // A regular `function` (not an arrow) — `new Stripe(key)` in lib/stripe.ts
  // requires a constructable mock; arrow functions can't be called with `new`.
  const StripeCtor = vi.fn().mockImplementation(function StripeMock() {
    return {
      prices: { retrieve: stripeMocks.pricesRetrieve },
      customers: {
        create: stripeMocks.customersCreate,
        update: stripeMocks.customersUpdate,
        list: stripeMocks.customersList,
        search: stripeMocks.customersSearch,
      },
      subscriptions: { create: stripeMocks.subscriptionsCreate, list: stripeMocks.subscriptionsList },
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
  stripeMocks.customersList.mockReset();
  stripeMocks.customersSearch.mockReset();
  stripeMocks.subscriptionsCreate.mockReset();
  stripeMocks.subscriptionsList.mockReset();
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
  // Safe defaults so every pre-existing test (which knows nothing about the
  // ENG-582 lookup calls) keeps behaving as a fresh member with no Stripe
  // history: no matching customers, no pending subscriptions.
  stripeMocks.customersList.mockResolvedValue({ data: [] });
  stripeMocks.customersSearch.mockResolvedValue({ data: [] });
  stripeMocks.subscriptionsList.mockResolvedValue({ data: [] });
}

// ---- ENG-582 fixture builders -----------------------------------------
// A fake Stripe Customer as returned by customers.list / customers.search.
function fakeCustomer(id: string, created: number, appUserId = "user-1") {
  return { id, created, metadata: { app_user_id: appUserId } };
}

// A fake Stripe Subscription entry as returned by subscriptions.list, already
// expanded the way the route requests (confirmation_secret on latest_invoice).
// Mirrors the live wire shape of a `subscriptions.list` entry expanded with
// `data.latest_invoice.confirmation_secret` at API version 2026-06-24.dahlia
// (verified against the sandbox — `latest_invoice.payment_intent` is genuinely
// ABSENT at this version, so it is deliberately not in this fixture).
//
// `metadata.app_user_id` and `cancel_at_period_end` are part of the fixture
// because the route re-asserts BOTH before adopting a pending subscription:
// without the metadata the be webhook cannot resolve the payer (charged but
// never activated), and without the pre-armed cancel we would hand out an
// auto-renewing pass.
function subEntry(
  id: string,
  created: number,
  clientSecret: string,
  priceId = "price_dummy",
  overrides: { appUserId?: string | null; cancelAtPeriodEnd?: boolean } = {},
) {
  const { appUserId = "user-1", cancelAtPeriodEnd = true } = overrides;
  return {
    id,
    created,
    items: { data: [{ price: { id: priceId } }] },
    cancel_at_period_end: cancelAtPeriodEnd,
    metadata: appUserId === null ? {} : { app_user_id: appUserId },
    latest_invoice: {
      confirmation_secret: { type: "payment_intent", client_secret: clientSecret },
    },
  };
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
      // ENG-582 added a 2nd arg (a deterministic idempotencyKey option) —
      // not asserted here, see the dedicated idempotency-key describe block.
      expect.anything(),
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

    // ENG-582 STRENGTHENED THIS. It used to read
    // `expect(subscriptionPatches.length).toBeGreaterThan(0)` as an anti-vacuity
    // guard — but that quietly encoded the RLS-denied write as *expected*
    // behaviour, and so helped hide the duplicate-Customer bug. The route now
    // writes to `subscription` NEVER, from either branch: `public.subscription`
    // exposes only SELECT policies to `authenticated`, so any write here is a
    // silent zero-row no-op and the be `stripe-webhook` (service role) is the
    // only supported write path. Zero patches is strictly stronger than the old
    // per-field allowlist, which is why that loop is gone rather than relaxed.
    expect(subscriptionPatches).toEqual([]);
    // Anti-vacuity is preserved by the two `toBe(200)` assertions above PLUS
    // this: the route really did run both branches end-to-end against Stripe.
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalledTimes(1);
  });
});

// ENG-582 — the checkout route must not create a fresh Stripe Customer or
// Subscription on every page load. These tests exercise the reuse/lookup
// logic added on top of the ENG-581 baseline above.
describe("ENG-582 — repeat visits reuse the same Stripe Customer", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("two successive POSTs create only ONE Stripe Customer", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersList.mockResolvedValue({ data: [] });
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    const res1 = await checkoutPOST();
    expect(res1.status).toBe(200);
    expect(stripeMocks.customersCreate).toHaveBeenCalledTimes(1);

    // Simulate Stripe's now-committed state as of the 2nd page load.
    stripeMocks.customersList.mockResolvedValue({ data: [fakeCustomer("cus_new", 1000, "user-1")] });

    const res2 = await checkoutPOST();
    expect(res2.status).toBe(200);

    expect(stripeMocks.customersCreate).toHaveBeenCalledTimes(1);
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith("cus_new", expect.anything());
    // The lookup must ALWAYS carry the email filter. Asserted positively:
    // an unfiltered `customers.list()` returns other members' Customers, and
    // dropping the arg would otherwise not fail a single test.
    expect(stripeMocks.customersList).toHaveBeenCalledWith(
      expect.objectContaining({ email: USER.email }),
    );
    // The Customer's email is refreshed on reuse — it is the primary, strongly
    // consistent lookup key, so letting it drift would demote this member to the
    // eventually-consistent search fallback forever.
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith(
      "cus_new",
      expect.objectContaining({ email: USER.email }),
    );
  });

  it("two successive POSTs do not create a second Subscription", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersList.mockResolvedValue({ data: [] });
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_A" });
    stripeMocks.subscriptionsList.mockResolvedValue({ data: [] });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_A",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_A_secret_x" } },
    });

    const res1 = await checkoutPOST();
    const body1 = await res1.json();
    expect(res1.status).toBe(200);
    expect(body1.data.clientSecret).toBe("pi_A_secret_x");

    // Simulate Stripe's committed state as of the 2nd load: the Customer AND
    // the pending Subscription both now exist.
    stripeMocks.customersList.mockResolvedValue({ data: [fakeCustomer("cus_A", 1000, "user-1")] });
    // Deliberately a DIFFERENT secret from the one `subscriptions.create`
    // returned on load 1. If the route echoed a remembered secret instead of the
    // re-expanded `latest_invoice.confirmation_secret` off the LIST response,
    // this assertion fails — which is the only way to prove ENG-581's
    // confirmation_secret read really is applied to the reuse path too.
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_A", 1000, "pi_A_ROTATED_secret")],
    });

    const res2 = await checkoutPOST();
    const body2 = await res2.json();

    expect(res2.status).toBe(200);
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(body2.data.subscriptionId).toBe("sub_A");
    expect(body2.data.clientSecret).toBe("pi_A_ROTATED_secret");
  });
});

describe("ENG-582 — CONCURRENT loads (the race the strongly-consistent lookups cannot close)", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  // Two OVERLAPPING requests, not two sequential ones. The checkout screen POSTs
  // from an on-mount effect whose cleanup does not abort the in-flight request,
  // so React StrictMode's double-invoke (or a double click / two tabs) really
  // does produce this. Both requests list BEFORE either creates, so both miss —
  // strong consistency cannot help. Only the idempotency keys collapse them.
  async function bothLoadsRaced() {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersList.mockResolvedValue({ data: [] });
    stripeMocks.subscriptionsList.mockResolvedValue({ data: [] });
    // Stripe collapses same-key creates server-side; model that here by keying
    // the mocks off the idempotencyKey the route sends.
    stripeMocks.customersCreate.mockImplementation(async (_params, opts) => ({
      id: `cus_for_${opts?.idempotencyKey}`,
    }));
    stripeMocks.subscriptionsCreate.mockImplementation(async (_params, opts) => ({
      id: `sub_for_${opts?.idempotencyKey}`,
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_secret" } },
    }));

    const [res1, res2] = await Promise.all([checkoutPOST(), checkoutPOST()]);
    return { res1, res2 };
  }

  it("two concurrent POSTs send an IDENTICAL idempotency key for the Customer", async () => {
    const { res1, res2 } = await bothLoadsRaced();
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const keys = stripeMocks.customersCreate.mock.calls.map((c) => c[1]?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    // Same key => Stripe returns one Customer, so the route resolves one id.
    const ids = stripeMocks.subscriptionsCreate.mock.calls.map((c) => c[0].customer);
    expect(new Set(ids).size).toBe(1);
  });

  it("two concurrent POSTs send an IDENTICAL idempotency key for the Subscription", async () => {
    // This is the assertion that fails without a key on subscriptions.create:
    // the Customer was collapsed by its own key while the Subscription was not,
    // so concurrent loads still stacked Subscriptions.
    const { res1, res2 } = await bothLoadsRaced();
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const keys = stripeMocks.subscriptionsCreate.mock.calls.map((c) => c[1]?.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeDefined();
    expect(keys[0]).toBe(keys[1]);
    // ...and therefore both requests resolve to a single Subscription.
    const bodies = await Promise.all([res1.json(), res2.json()]);
    expect(new Set(bodies.map((b) => b.data.subscriptionId)).size).toBe(1);
  });

  it("the idempotency key is bucketed in time, so a replay cannot outlive what it protects", async () => {
    vi.useFakeTimers();
    // Stripe replays a key for 24h, but an untouched `incomplete` Subscription
    // expires at ~23h and a deleted Customer would replay as a dead id. A 10-min
    // bucket keeps the collapse window far shorter than either hazard.
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    await bothLoadsRaced();
    const early = stripeMocks.subscriptionsCreate.mock.calls[0][1]?.idempotencyKey;

    resetAll();
    vi.setSystemTime(new Date("2026-08-16T02:00:00Z"));
    await bothLoadsRaced();
    const later = stripeMocks.subscriptionsCreate.mock.calls[0][1]?.idempotencyKey;

    expect(early).toBeDefined();
    expect(later).toBeDefined();
    expect(later).not.toBe(early);
  });
});

describe("ENG-582 — a pending Subscription is only adopted if it is really ours", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  function pendingCustomerAlreadyExists() {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersList.mockResolvedValue({ data: [fakeCustomer("cus_A", 1000, "user-1")] });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_fresh",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_fresh_secret" } },
    });
  }

  it("ignores a pending Subscription with no app_user_id metadata (webhook could not resolve the payer)", async () => {
    pendingCustomerAlreadyExists();
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_foreign", 9999, "pi_foreign_secret", "price_dummy", { appUserId: null })],
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.mode).toBe("purchase");
    // Must NOT hand back the unresolvable subscription's secret — paying against
    // it would charge the member and never activate them.
    expect(body.data.subscriptionId).toBe("sub_fresh");
    expect(body.data.clientSecret).toBe("pi_fresh_secret");
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending Subscription belonging to a different app_user_id", async () => {
    pendingCustomerAlreadyExists();
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_other", 9999, "pi_other_secret", "price_dummy", { appUserId: "someone-else" })],
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.subscriptionId).toBe("sub_fresh");
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending Subscription without cancel_at_period_end (the pass must never auto-renew)", async () => {
    pendingCustomerAlreadyExists();
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_renewing", 9999, "pi_renewing_secret", "price_dummy", { cancelAtPeriodEnd: false })],
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.subscriptionId).toBe("sub_fresh");
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
    // The freshly created one still arms the cancel at creation.
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ cancel_at_period_end: true }),
      expect.anything(),
    );
  });
});

describe("ENG-582 — the DB stripe_customer_id short-circuits any Stripe lookup", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("reuses the DB stripe_customer_id without any Stripe lookup", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: "cus_db", current_period_end: null } };
    tableData.app_user = { data: { first_name: "Ada", last_name: "Lovelace", postcode: "2000" } };
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    const res = await checkoutPOST();
    expect(res.status).toBe(200);

    expect(stripeMocks.customersList).not.toHaveBeenCalled();
    expect(stripeMocks.customersSearch).not.toHaveBeenCalled();
    expect(stripeMocks.customersCreate).not.toHaveBeenCalled();
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith(
      "cus_db",
      expect.objectContaining({
        name: "Ada Lovelace",
        address: { postal_code: "2000", country: "AU" },
      }),
    );
  });
});

describe("ENG-582 — newest-first Customer selection is deterministic and stable", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("picks ONE customer deterministically and stably when several share the app_user_id", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersList.mockResolvedValue({
      data: [
        fakeCustomer("cus_1", 1786857564),
        fakeCustomer("cus_2", 1786859931),
        fakeCustomer("cus_3", 1786859955), // newest
        fakeCustomer("cus_4", 1786857594),
        fakeCustomer("cus_5", 1786859895),
      ],
    });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();

    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith("cus_3", expect.anything());
    expect(stripeMocks.customersCreate).not.toHaveBeenCalled();

    stripeMocks.customersUpdate.mockClear();

    // Same input, second load — must resolve to the SAME customer.
    await checkoutPOST();

    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith("cus_3", expect.anything());
    expect(stripeMocks.customersCreate).not.toHaveBeenCalled();
  });

  it("breaks a created-second tie deterministically (id descending)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersList.mockResolvedValue({
      data: [fakeCustomer("cus_aaa", 2000), fakeCustomer("cus_zzz", 2000)],
    });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith("cus_zzz", expect.anything());

    stripeMocks.customersUpdate.mockClear();

    await checkoutPOST();
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith("cus_zzz", expect.anything());
  });

  it("ignores customers belonging to a different app_user_id", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersList.mockResolvedValue({
      data: [fakeCustomer("cus_other", 5000, "someone-else"), fakeCustomer("cus_mine", 1000, "user-1")],
    });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();

    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith("cus_mine", expect.anything());
    expect(stripeMocks.customersCreate).not.toHaveBeenCalled();
  });
});

describe("ENG-582 — newest-first pending-Subscription selection is deterministic and stable", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("picks ONE incomplete subscription deterministically and stably when several exist", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: "cus_existing", current_period_end: null } };
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [
        subEntry("sub_b", 2000, "pi_b_secret"),
        subEntry("sub_c", 3000, "pi_c_secret"), // newest
        subEntry("sub_a", 1000, "pi_a_secret"),
      ],
    });

    const res1 = await checkoutPOST();
    const body1 = await res1.json();
    expect(res1.status).toBe(200);
    expect(body1.data.clientSecret).toBe("pi_c_secret");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();

    const res2 = await checkoutPOST();
    const body2 = await res2.json();
    expect(body2.data.clientSecret).toBe("pi_c_secret");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("breaks a same-created-second Subscription tie deterministically (id descending)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: "cus_existing", current_period_end: null } };
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_aaa", 4000, "pi_aaa_secret"), subEntry("sub_zzz", 4000, "pi_zzz_secret")],
    });

    const res1 = await checkoutPOST();
    const body1 = await res1.json();
    expect(body1.data.clientSecret).toBe("pi_zzz_secret");

    const res2 = await checkoutPOST();
    const body2 = await res2.json();
    expect(body2.data.clientSecret).toBe("pi_zzz_secret");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("ignores an incomplete subscription for a different price", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: "cus_existing", current_period_end: null } };
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_other_price", 5000, "pi_other_secret", "price_other")],
    });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(body.data.clientSecret).toBe("pi_new_secret");
  });
});

describe("ENG-582 — customers.search fallback when the member has no email", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("falls back to customers.search when the member has no email", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: undefined } } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersSearch.mockResolvedValue({ data: [fakeCustomer("cus_found", 1000)] });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();

    // NEVER call customers.list() without an email filter — an unfiltered
    // list would return other members' Customers.
    expect(stripeMocks.customersList).not.toHaveBeenCalled();
    expect(stripeMocks.customersSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining("metadata['app_user_id']:'user-1'") }),
    );
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith("cus_found", expect.anything());
    expect(stripeMocks.customersCreate).not.toHaveBeenCalled();
  });

  it("discards a search hit whose metadata does not actually match this member", async () => {
    // Defence in depth: the query string is not trusted to have scoped the
    // result — the route re-checks metadata locally, so a widened/parsed-oddly
    // query can never cross-wire billing to another member's Customer.
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: undefined } } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersSearch.mockResolvedValue({
      data: [fakeCustomer("cus_someone_else", 9999, "someone-else"), fakeCustomer("cus_mine", 1000, "user-1")],
    });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    const res = await checkoutPOST();
    expect(res.status).toBe(200);
    // The foreign customer is NEWER, so a naive newest-first pick would take it.
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith("cus_mine", expect.anything());
  });

  it("search results are also picked newest-first and stably", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1", email: undefined } } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersSearch.mockResolvedValue({
      data: [fakeCustomer("cus_b", 2000), fakeCustomer("cus_c", 3000), fakeCustomer("cus_a", 1000)],
    });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith("cus_c", expect.anything());

    stripeMocks.customersUpdate.mockClear();

    await checkoutPOST();
    expect(stripeMocks.customersUpdate).toHaveBeenCalledWith("cus_c", expect.anything());
    expect(stripeMocks.customersCreate).not.toHaveBeenCalled();
  });
});

describe("ENG-582 — deterministic idempotency key on customers.create", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("passes a deterministic idempotency key on customers.create, stable per identity and distinct per edit", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    tableData.app_user = { data: { first_name: "Jane", last_name: "Doe", postcode: "3000" } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();

    expect(stripeMocks.customersCreate).toHaveBeenCalledWith(expect.anything(), {
      idempotencyKey: expect.stringContaining("eng582-customer-user-1-"),
    });
    const key1 = stripeMocks.customersCreate.mock.calls[0][1].idempotencyKey;

    // Reset only the call recorder — a second, separate POST with the SAME
    // identity must produce the SAME key.
    stripeMocks.customersCreate.mockClear();

    const res2 = await checkoutPOST();
    expect(res2.status).toBe(200);
    const key2 = stripeMocks.customersCreate.mock.calls[0][1].idempotencyKey;
    expect(key2).toBe(key1);

    // A genuine identity edit (postcode changes) must produce a DIFFERENT key
    // — otherwise Stripe rejects the reused key with `idempotency_error`.
    stripeMocks.customersCreate.mockClear();
    tableData.app_user = { data: { first_name: "Jane", last_name: "Doe", postcode: "3001" } };

    await checkoutPOST();
    const key3 = stripeMocks.customersCreate.mock.calls[0][1].idempotencyKey;
    expect(key3).not.toBe(key1);
  });
});

describe("ENG-582 — GUARDRAIL: no RLS-denied write to `subscription` remains", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("never attempts a write to subscription on Branch A (purchase)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: { status: "trial", stripe_customer_id: null, current_period_end: null } };
    stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    // Pin a positive result FIRST — an all-negative assertion set passes
    // vacuously on a 402 (.rx/gotchas.md).
    expect(res.status).toBe(200);
    expect(body.data.mode).toBe("purchase");

    expect(updateMock.mock.calls.filter((c) => c[0] === "subscription")).toHaveLength(0);
  });

  it("never attempts a write to subscription on Branch B (renewal)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    const futureEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    tableData.subscription = {
      data: { status: "active", stripe_customer_id: "cus_existing", current_period_end: futureEnd },
    };
    stripeMocks.paymentIntentsCreate.mockResolvedValue({ client_secret: "pi_renew_secret" });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.mode).toBe("renewal");

    expect(updateMock.mock.calls.filter((c) => c[0] === "subscription")).toHaveLength(0);
  });
});

describe("ENG-582 — Branch B (early renewal) still resolves an existing Customer and skips the subscription list", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("active member with no DB stripe_customer_id: reuses the Stripe-resolved Customer for a PaymentIntent, never lists subscriptions", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    const futureEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
    tableData.subscription = { data: { status: "active", stripe_customer_id: null, current_period_end: futureEnd } };
    stripeMocks.customersList.mockResolvedValue({ data: [fakeCustomer("cus_x", 1000)] });
    stripeMocks.paymentIntentsCreate.mockResolvedValue({ client_secret: "pi_renew_secret" });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.mode).toBe("renewal");
    expect(stripeMocks.paymentIntentsCreate).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_x" }));
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.subscriptionsList).not.toHaveBeenCalled();
  });
});
