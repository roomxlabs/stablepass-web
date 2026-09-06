import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocks the `stripe` SDK itself (not just our lib/stripe.ts wrapper) so the
// lazy-init helper (getStripe) is exercised for real: `new Stripe(key)` only
// happens when STRIPE_SECRET_KEY is set, mirroring the module-scope-throw fix.
// Also mocks supabaseServer with the same chainable query-builder stub used by
// me-route.test.ts (select/update/eq return itself; single()/maybeSingle()
// each resolve a per-table fixture; updateMock records the exact patch passed
// to `.update`).
const { getUserMock, fromMock, updateMock, selectMock, tableData, stripeMocks, StripeCtor } = vi.hoisted(() => {
  const getUserMock = vi.fn();
  const updateMock = vi.fn();
  // Records (table, projection) for every `.select(...)`. A fresh chain object is
  // built per `from()` call, so the chain's own spy cannot be asserted across
  // calls (.rx/gotchas.md, "asserting .select() args needs a PERSISTENT chain");
  // recording into one module-level mock is the same trick `updateMock` already
  // uses for `.update`, and it lets a test pin the EXACT projection string.
  const selectMock = vi.fn();
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
    chain.select.mockImplementation((projection: unknown) => {
      selectMock(table, projection);
      return chain;
    });
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
    couponsRetrieve: vi.fn(),
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
      coupons: { retrieve: stripeMocks.couponsRetrieve },
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

  return { getUserMock, fromMock, updateMock, selectMock, tableData, stripeMocks, StripeCtor };
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

// CONTRACT: the exact key set the screen destructures. Renaming any of these
// in the route (publishableKey especially) otherwise keeps every test green
// while breaking the real screen.
const CHECKOUT_DATA_KEYS = [
  "amountDueNow",
  "clientSecret",
  "currency",
  "discountAmount",
  "introMonthsRemaining",
  "mode",
  "priceChangesOn",
  "publishableKey",
  "subscriptionId",
  "unitAmount",
].sort();

// MOCK Stripe fixtures (what `prices.retrieve` / `coupons.retrieve` return) —
// NOT application constants. The app never hardcodes an amount.
const STANDARD_UNIT_AMOUNT = 1900;
const PROMO_UNIT_AMOUNT = 900;
const INTRO_AMOUNT_OFF = 1000;

function resetAll() {
  getUserMock.mockReset();
  fromMock.mockClear();
  updateMock.mockClear();
  selectMock.mockClear();
  StripeCtor.mockClear();
  stripeMocks.pricesRetrieve.mockReset();
  stripeMocks.couponsRetrieve.mockReset();
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
    // Left set on purpose: the route must NEVER read it (ENG-1027). Tests
    // below assert prices.retrieve is never called with this id.
    STRIPE_PRICE_ID_PROMO: "price_promo",
    STRIPE_PRICE_ID_STANDARD: "price_standard",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_dummy",
  };
  stripeMocks.pricesRetrieve.mockImplementation(async (id: string) => {
    if (id === "price_standard") return { unit_amount: STANDARD_UNIT_AMOUNT, currency: "aud" };
    if (id === "price_promo") return { unit_amount: PROMO_UNIT_AMOUNT, currency: "aud" };
    // Anything else REJECTS, mirroring stripe-node: an absent or unknown price id
    // is an error, not a price. Returning a plausible amount here would make an
    // UNSET `STRIPE_PRICE_ID_STANDARD` env var look like a successful checkout.
    throw new Error(`No such price: ${String(id)}`);
  });
  stripeMocks.couponsRetrieve.mockImplementation(async (id: string) => {
    if (/^intro_[1-6]$/.test(id)) return { id, amount_off: INTRO_AMOUNT_OFF, currency: "aud" };
    throw new Error(`No such coupon: ${String(id)}`);
  });
  // Safe defaults so every pre-existing test (which knows nothing about the
  // ENG-582 lookup calls) keeps behaving as a fresh member with no Stripe
  // history: no matching customers, no pending subscriptions.
  stripeMocks.customersList.mockResolvedValue({ data: [] });
  stripeMocks.customersSearch.mockResolvedValue({ data: [] });
  stripeMocks.subscriptionsList.mockResolvedValue({ data: [] });
}

function memberRow(
  overrides: {
    status?: string | null;
    stripe_customer_id?: string | null;
    intro_months_used?: number | null;
  } = {},
) {
  return {
    status: overrides.status ?? "trial",
    stripe_customer_id: overrides.stripe_customer_id === undefined ? null : overrides.stripe_customer_id,
    intro_months_used: overrides.intro_months_used === undefined ? 0 : overrides.intro_months_used,
  };
}

function stubCreates(subId = "sub_new", secret = "pi_new_secret") {
  stripeMocks.customersCreate.mockResolvedValue({ id: "cus_new" });
  stripeMocks.subscriptionsCreate.mockResolvedValue({
    id: subId,
    latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: secret } },
  });
}

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
// Default `cancel_at_period_end: false` matches our create path (ENG-1027).
// Pass-era leftovers with `true` must be passed via overrides and must NOT
// be reused. Default price is STANDARD — promo leftovers are not reusable.
function subEntry(
  id: string,
  created: number,
  clientSecret: string,
  priceId = "price_standard",
  overrides: { appUserId?: string | null; cancelAtPeriodEnd?: boolean } = {},
) {
  const { appUserId = "user-1", cancelAtPeriodEnd = false } = overrides;
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

function executableSource(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_unavailable");
    expect(StripeCtor).not.toHaveBeenCalled();
  });

  it("non-active member: creates a renewing incomplete Subscription and returns mode:'subscribe'", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    stubCreates();

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.mode).toBe("subscribe");
    expect(body.data.clientSecret).toBe("pi_new_secret");

    const createCall = stripeMocks.subscriptionsCreate.mock.calls[0][0];
    expect(createCall.cancel_at_period_end).toBe(false);
    expect(createCall.payment_settings.save_default_payment_method).toBe("on_subscription");
    expect(createCall.metadata).toEqual({ app_user_id: "user-1" });
    expect(createCall.payment_behavior).toBe("default_incomplete");
  });

  it("expands latest_invoice.confirmation_secret — the legacy payment_intent path alone yields no secret at 2026-06-24.dahlia", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    stubCreates();

    await checkoutPOST();

    const expandArg = stripeMocks.subscriptionsCreate.mock.calls[0][0].expand;
    expect(expandArg).toContain("latest_invoice.confirmation_secret");
    // Kept as a cross-version fallback for an account pinned to an older API version.
    expect(expandArg).toContain("latest_invoice.payment_intent");
  });

  it("new shape only (no payment_intent key): still returns a usable clientSecret", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    stubCreates("sub_new", "pi_conf_secret");

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.clientSecret).toBe("pi_conf_secret");
  });

  it("legacy shape only: the payment_intent fallback still resolves (older pinned API version)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    tableData.app_user = { data: { first_name: "Jane", last_name: "Doe", postcode: "3000" } };
    stubCreates();

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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    tableData.app_user = { data: { first_name: "Jane", last_name: "Doe", postcode: null } };
    stubCreates();

    await checkoutPOST();

    const addressArg = stripeMocks.customersCreate.mock.calls[0][0].address;
    expect(addressArg).not.toHaveProperty("postal_code");
    expect(addressArg.country).toBe("AU");
  });

  it("existing stripe_customer_id: updates the Customer instead of creating a new one", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
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

  it("active member: 409 already_active — no Stripe Customer/Subscription/PaymentIntent create", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "active", stripe_customer_id: "cus_existing" }) };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("already_active");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.customersCreate).not.toHaveBeenCalled();
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("no mode:'renewal' is reachable: an active member is 409, not a 200 renewal", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "active", stripe_customer_id: "cus_existing" }) };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("already_active");
    expect(body.data).toBeUndefined();
    expect(body.error.code).not.toBeUndefined();
  });

  it("prices.retrieve rejecting returns 502 stripe_error (NOT stripe_unavailable — the key is fine)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    stripeMocks.pricesRetrieve.mockRejectedValue(new Error("stripe down"));
    tableData.subscription = { data: memberRow({ status: "trial" }) };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    // ENG-581: a working key that Stripe rejected is NOT a configuration
    // problem. Sharing `stripe_unavailable` here is what made the screen tell a
    // correctly-configured operator their key was missing.
    expect(body.error.code).toBe("stripe_error");
    expect(body.error.code).not.toBe("stripe_unavailable");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("prices.retrieve resolving a null unit_amount returns 502 stripe_error without charging", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    stripeMocks.pricesRetrieve.mockResolvedValue({ unit_amount: null, currency: "aud" });
    tableData.subscription = { data: memberRow({ status: "trial" }) };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("subscribe response echoes unitAmount, discountAmount, amountDueNow and currency alongside clientSecret", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", intro_months_used: 0 }) };
    stubCreates();

    const res = await checkoutPOST();
    const body = await res.json();
    expect(body.data.unitAmount).toBe(1900);
    expect(body.data.discountAmount).toBe(1000);
    expect(body.data.amountDueNow).toBe(900);
    expect(body.data.currency).toBe("aud");
    expect(body.data.clientSecret).toBe("pi_new_secret");
    expect(body.data.mode).toBe("subscribe");
  });

  it("returns 502 stripe_error when Stripe throws creating the Subscription", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
    stripeMocks.subscriptionsCreate.mockRejectedValue(new Error("stripe boom"));

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
  });

  it("coupon missing amount_off returns 502 stripe_error without charging", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", intro_months_used: 0 }) };
    stripeMocks.couponsRetrieve.mockResolvedValue({ id: "intro_6", currency: "aud" });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
  });

  it("CONTRACT: the subscribe response carries exactly the keys the screen reads", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    const body = await (await checkoutPOST()).json();

    expect(Object.keys(body.data).sort()).toEqual(CHECKOUT_DATA_KEYS);
    expect(body.data.mode).toBe("subscribe");
  });

  // Stripe treats an address hash on UPDATE as a full replacement, so sending a
  // bare { country: "AU" } for a member with no postcode would silently destroy
  // the postal_code Stripe already holds — on every checkout POST.
  it("existing customer with no postcode: omits `address` entirely rather than wiping the stored one", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
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
  // NEVER grants access. Only the be webhook may write `status`.
  it("GUARDRAIL: never writes `status` (let alone 'active') to the subscription table — only the webhook grants access", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });

    tableData.subscription = { data: memberRow({ status: "trial" }) };
    stubCreates();

    expect((await checkoutPOST()).status).toBe(200);

    const subscriptionPatches = updateMock.mock.calls
      .filter((c) => c[0] === "subscription")
      .map((c) => c[1] as Record<string, unknown>);

    expect(subscriptionPatches).toEqual([]);
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    stripeMocks.customersList.mockResolvedValue({ data: [] });
    stubCreates();

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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    stripeMocks.customersList.mockResolvedValue({ data: [] });
    stubCreates("sub_A", "pi_A_secret_x");

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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    stripeMocks.customersList.mockResolvedValue({ data: [fakeCustomer("cus_A", 1000, "user-1")] });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_fresh",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_fresh_secret" } },
    });
  }

  it("ignores a pending Subscription with no app_user_id metadata (webhook could not resolve the payer)", async () => {
    pendingCustomerAlreadyExists();
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_foreign", 9999, "pi_foreign_secret", "price_standard", { appUserId: null })],
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.mode).toBe("subscribe");
    // Must NOT hand back the unresolvable subscription's secret — paying against
    // it would charge the member and never activate them.
    expect(body.data.subscriptionId).toBe("sub_fresh");
    expect(body.data.clientSecret).toBe("pi_fresh_secret");
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending Subscription belonging to a different app_user_id", async () => {
    pendingCustomerAlreadyExists();
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_other", 9999, "pi_other_secret", "price_standard", { appUserId: "someone-else" })],
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.subscriptionId).toBe("sub_fresh");
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending Subscription with cancel_at_period_end true (pass-era leftover must never be reused)", async () => {
    pendingCustomerAlreadyExists();
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_pass_era", 9999, "pi_pass_secret", "price_standard", { cancelAtPeriodEnd: true })],
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.subscriptionId).toBe("sub_fresh");
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ cancel_at_period_end: false }),
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
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_db" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
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
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    tableData.app_user = { data: { first_name: "Jane", last_name: "Doe", postcode: "3000" } };
    stubCreates();

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

  it("never attempts a write to subscription on subscribe", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    stubCreates();

    const res = await checkoutPOST();
    const body = await res.json();

    // Pin a positive result FIRST — an all-negative assertion set passes
    // vacuously on a 402 (.rx/gotchas.md).
    expect(res.status).toBe(200);
    expect(body.data.mode).toBe("subscribe");

    expect(updateMock.mock.calls.filter((c) => c[0] === "subscription")).toHaveLength(0);
  });

  it("never attempts a write to subscription on the already_active 409 either", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "active", stripe_customer_id: "cus_existing" }) };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe("already_active");

    expect(updateMock.mock.calls.filter((c) => c[0] === "subscription")).toHaveLength(0);
  });
});

describe("ENG-1027 — the intro coupon is chosen server-side", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  function freshMember(introMonthsUsed: number | null) {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "lapsed", stripe_customer_id: "cus_existing", intro_months_used: introMonthsUsed }) };
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });
  }

  it("used 0 → coupon intro_6, STANDARD price, amountDueNow 900", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T00:00:00Z"));
    freshMember(0);

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(stripeMocks.pricesRetrieve).toHaveBeenCalledWith("price_standard");
    expect(stripeMocks.pricesRetrieve).not.toHaveBeenCalledWith("price_promo");
    expect(stripeMocks.couponsRetrieve).toHaveBeenCalledWith("intro_6");
    const createCall = stripeMocks.subscriptionsCreate.mock.calls[0][0];
    expect(createCall.items[0].price).toBe("price_standard");
    expect(createCall.discounts).toEqual([{ coupon: "intro_6" }]);
    expect(body.data.mode).toBe("subscribe");
    expect(body.data.unitAmount).toBe(1900);
    expect(body.data.discountAmount).toBe(1000);
    expect(body.data.amountDueNow).toBe(900);
    expect(body.data.introMonthsRemaining).toBe(6);
    expect(body.data.priceChangesOn).toBe("March 2027");
  });

  it("used 2 → coupon intro_4, amountDueNow 900", async () => {
    freshMember(2);

    const res = await checkoutPOST();
    const body = await res.json();

    expect(stripeMocks.couponsRetrieve).toHaveBeenCalledWith("intro_4");
    expect(stripeMocks.pricesRetrieve).toHaveBeenCalledWith("price_standard");
    expect(body.data.amountDueNow).toBe(900);
    expect(body.data.unitAmount).toBe(1900);
    expect(body.data.discountAmount).toBe(1000);
    expect(body.data.introMonthsRemaining).toBe(4);
    const createCall = stripeMocks.subscriptionsCreate.mock.calls[0][0];
    expect(createCall.discounts).toEqual([{ coupon: "intro_4" }]);
  });

  it("used 6 → no coupon retrieve, no discounts, full STANDARD price", async () => {
    freshMember(6);

    const res = await checkoutPOST();
    const body = await res.json();

    expect(stripeMocks.couponsRetrieve).not.toHaveBeenCalled();
    expect(stripeMocks.pricesRetrieve).toHaveBeenCalledWith("price_standard");
    const createCall = stripeMocks.subscriptionsCreate.mock.calls[0][0];
    expect(createCall).not.toHaveProperty("discounts");
    expect(body.data.amountDueNow).toBe(1900);
    expect(body.data.discountAmount).toBe(0);
    expect(body.data.introMonthsRemaining).toBe(0);
    expect(body.data.priceChangesOn).toBeNull();
    expect(body.data.unitAmount).toBe(1900);
  });

  it("used 9 → no coupon, remaining 0", async () => {
    freshMember(9);

    const res = await checkoutPOST();
    const body = await res.json();

    expect(stripeMocks.couponsRetrieve).not.toHaveBeenCalled();
    expect(body.data.introMonthsRemaining).toBe(0);
    expect(body.data.amountDueNow).toBe(1900);
    expect(body.data.priceChangesOn).toBeNull();
  });

  it("null used → intro_6 (fail toward the discount)", async () => {
    freshMember(null);

    const res = await checkoutPOST();
    const body = await res.json();

    expect(stripeMocks.couponsRetrieve).toHaveBeenCalledWith("intro_6");
    expect(body.data.introMonthsRemaining).toBe(6);
    expect(body.data.amountDueNow).toBe(900);
  });

  it("no subscription row (PGRST116) → intro_6", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = {
      data: null,
      error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
    };
    stubCreates();

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(stripeMocks.couponsRetrieve).toHaveBeenCalledWith("intro_6");
    expect(body.data.introMonthsRemaining).toBe(6);
    expect(body.data.amountDueNow).toBe(900);
  });

  it("NaN used → intro_6 (fail toward the discount)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = {
      data: {
        status: "lapsed",
        stripe_customer_id: "cus_existing",
        intro_months_used: Number.NaN,
      },
    };
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    const body = await (await checkoutPOST()).json();

    expect(stripeMocks.couponsRetrieve).toHaveBeenCalledWith("intro_6");
    expect(body.data.introMonthsRemaining).toBe(6);
  });

  it("GUARDRAIL: POST.length === 0 — calling POST() with no args still uses the DB coupon", async () => {
    expect(checkoutPOST.length).toBe(0);

    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", intro_months_used: 6 }) };
    stubCreates();

    const body = await (await checkoutPOST()).json();

    expect(body.data.amountDueNow).toBe(1900);
    expect(body.data.introMonthsRemaining).toBe(0);
    expect(stripeMocks.couponsRetrieve).not.toHaveBeenCalled();
    expect(fromMock).toHaveBeenCalledWith("subscription");
  });

  it("prices.retrieve is ALWAYS called with price_standard, never price_promo", async () => {
    for (const used of [0, 2, 6, 9]) {
      resetAll();
      freshMember(used);
      await checkoutPOST();
      expect(stripeMocks.pricesRetrieve).toHaveBeenCalledWith("price_standard");
      expect(stripeMocks.pricesRetrieve).not.toHaveBeenCalledWith("price_promo");
    }
  });

  it("create has cancel_at_period_end false AND save_default_payment_method on_subscription", async () => {
    freshMember(0);
    await checkoutPOST();

    const createCall = stripeMocks.subscriptionsCreate.mock.calls[0][0];
    expect(createCall.cancel_at_period_end).toBe(false);
    expect(createCall.payment_settings.save_default_payment_method).toBe("on_subscription");
  });
});

describe("ENG-1027 — reuse filter (STANDARD price, cancel_at_period_end false, quantity)", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("pending with cancel_at_period_end true is NOT reused (create is called)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_pass_era", 1000, "pi_pass_secret", "price_standard", { cancelAtPeriodEnd: true })],
    });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_fresh",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_fresh_secret" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(body.data.subscriptionId).toBe("sub_fresh");
  });

  it("pending with cancel_at_period_end false at price_standard IS reused (create not called)", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_pending_standard", 1000, "pi_pending_secret", "price_standard")],
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(body.data.subscriptionId).toBe("sub_pending_standard");
  });

  it("two sequential POSTs resolve to the same subscriptionId", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing", intro_months_used: 6 }) };
    stripeMocks.subscriptionsList.mockResolvedValue({ data: [] });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_std_A",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_std_A_secret" } },
    });

    const res1 = await checkoutPOST();
    const body1 = await res1.json();
    expect(res1.status).toBe(200);
    expect(body1.data.subscriptionId).toBe("sub_std_A");

    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_std_A", 1000, "pi_std_A_ROTATED_secret", "price_standard")],
    });

    const res2 = await checkoutPOST();
    const body2 = await res2.json();

    expect(res2.status).toBe(200);
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(body2.data.subscriptionId).toBe("sub_std_A");
  });

  it("pending at price_promo is NOT reused", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_pending_promo", 1000, "pi_pending_secret", "price_promo")],
    });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new_standard",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_standard_secret" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
    const createCall = stripeMocks.subscriptionsCreate.mock.calls[0][0];
    expect(createCall.items[0].price).toBe("price_standard");
    expect(body.data.subscriptionId).toBe("sub_new_standard");
  });

  it("pending missing app_user_id is NOT reused", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial", stripe_customer_id: "cus_existing" }) };
    stripeMocks.subscriptionsList.mockResolvedValue({
      data: [subEntry("sub_foreign", 9999, "pi_foreign_secret", "price_standard", { appUserId: null })],
    });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_fresh_standard",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_fresh_secret" } },
    });

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.subscriptionId).toBe("sub_fresh_standard");
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
  });

  it("pending quantity 3 is NOT reused; quantity 1 IS reused", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "lapsed", stripe_customer_id: "cus_existing" }) };

    const bulk = subEntry("sub_bulk", 9999, "pi_bulk_secret", "price_standard");
    bulk.items.data[0] = { ...bulk.items.data[0], quantity: 3 } as (typeof bulk.items.data)[0];
    stripeMocks.subscriptionsList.mockResolvedValue({ data: [bulk] });
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_fresh",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_fresh_secret" } },
    });

    const bodyBulk = await (await checkoutPOST()).json();
    expect(stripeMocks.subscriptionsCreate).toHaveBeenCalledTimes(1);
    expect(bodyBulk.data.subscriptionId).toBe("sub_fresh");

    stripeMocks.subscriptionsCreate.mockClear();
    const single = subEntry("sub_single", 9999, "pi_single_secret", "price_standard");
    single.items.data[0] = { ...single.items.data[0], quantity: 1 } as (typeof single.items.data)[0];
    stripeMocks.subscriptionsList.mockResolvedValue({ data: [single] });

    const bodySingle = await (await checkoutPOST()).json();
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(bodySingle.data.subscriptionId).toBe("sub_single");
  });
});

describe("ENG-1027 — money-critical invariants", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  function freshMember(introMonthsUsed: number) {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = {
      data: memberRow({ status: "lapsed", stripe_customer_id: "cus_existing", intro_months_used: introMonthsUsed }),
    };
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });
  }

  it("the idempotency key DIVERGES when remaining/coupon changes inside one time bucket (used 0 vs used 6)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T00:00:00Z"));

    freshMember(0);
    await checkoutPOST();
    const introKey = stripeMocks.subscriptionsCreate.mock.calls[0][1]?.idempotencyKey;

    stripeMocks.subscriptionsCreate.mockClear();
    freshMember(6);
    await checkoutPOST();
    const fullKey = stripeMocks.subscriptionsCreate.mock.calls[0][1]?.idempotencyKey;

    expect(introKey).toBeDefined();
    expect(fullKey).toBeDefined();
    expect(fullKey).not.toBe(introKey);
  });

  it("an UNSET STRIPE_PRICE_ID_STANDARD is a distinguishable 502 stripe_error (prices.retrieve throws)", async () => {
    delete process.env.STRIPE_PRICE_ID_STANDARD;
    freshMember(0);

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("stripe_error");
    expect(body.error.code).not.toBe("stripe_unavailable");
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("GUARDRAIL: a FAILED subscription read (42703 — intro_months_used not deployed) fails CLOSED", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = {
      data: null,
      error: { code: "42703", message: `column subscription.intro_months_used does not exist` },
    };

    const res = await checkoutPOST();
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error.code).toBe("subscription_unavailable");
    // Distinct from BOTH existing 502s — a DB failure reported as a Stripe
    // failure is the ENG-581 misdirection all over again.
    expect(body.error.code).not.toBe("stripe_error");
    expect(body.error.code).not.toBe("stripe_unavailable");
    expect(stripeMocks.customersCreate).not.toHaveBeenCalled();
    expect(stripeMocks.subscriptionsCreate).not.toHaveBeenCalled();
    expect(stripeMocks.paymentIntentsCreate).not.toHaveBeenCalled();
  });

  it("stripe_error and stripe_unavailable stay distinct codes", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial" }) };
    stripeMocks.pricesRetrieve.mockRejectedValue(new Error("stripe down"));

    const errorRes = await checkoutPOST();
    const errorBody = await errorRes.json();
    expect(errorRes.status).toBe(502);
    expect(errorBody.error.code).toBe("stripe_error");

    resetAll();
    delete process.env.STRIPE_SECRET_KEY;
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "trial" }) };

    const unavailRes = await checkoutPOST();
    const unavailBody = await unavailRes.json();
    expect(unavailRes.status).toBe(502);
    expect(unavailBody.error.code).toBe("stripe_unavailable");
    expect(unavailBody.error.code).not.toBe(errorBody.error.code);
    expect(StripeCtor).not.toHaveBeenCalled();
  });
});

describe("ENG-1027 — the subscription projection is pinned exactly", () => {
  beforeEach(resetAll);
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.useRealTimers();
  });

  it("selects exactly status,stripe_customer_id,intro_months_used", async () => {
    getUserMock.mockResolvedValue({ data: { user: USER } });
    tableData.subscription = { data: memberRow({ status: "lapsed", stripe_customer_id: "cus_existing", intro_months_used: 0 }) };
    stripeMocks.subscriptionsCreate.mockResolvedValue({
      id: "sub_new",
      latest_invoice: { confirmation_secret: { type: "payment_intent", client_secret: "pi_new_secret" } },
    });

    await checkoutPOST();

    const subSelects = selectMock.mock.calls.filter(([table]) => table === "subscription");
    expect(subSelects).toHaveLength(1);
    expect(subSelects[0][1]).toBe("status,stripe_customer_id,intro_months_used");
  });
});

describe("ENG-1027 — source guard: Branch B / promo price / renewal are gone", () => {
  it("the checkout route no longer reads STRIPE_PRICE_ID_PROMO, THIRTY_DAYS_MS, or renewal mode", () => {
    const src = readFileSync(resolve(process.cwd(), "app/api/subscription/checkout/route.ts"), "utf8");
    const code = executableSource(src);

    expect(src).not.toContain("process.env.STRIPE_PRICE_ID_PROMO");
    expect(code).not.toContain("THIRTY_DAYS_MS");
    expect(code).not.toMatch(/kind:\s*["']renewal["']/);
    expect(code).not.toMatch(/mode:\s*["']renewal["']/);
  });
});
