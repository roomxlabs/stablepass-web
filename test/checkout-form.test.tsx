import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Kept light per the ticket: this exercises the mount → POST /api/subscription/checkout
// → subscribe / graceful-placeholder paths, not a live Stripe Elements mount.
// @stripe/stripe-js and @stripe/react-stripe-js are stubbed so importing
// checkout-form.tsx doesn't try to load the real Stripe.js script in jsdom.
const { pushMock, replaceMock, assignMock, stripeRef } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  assignMock: vi.fn(),
  stripeRef: {
    current: null as null | {
      confirmPayment: (...args: unknown[]) => Promise<unknown>;
      confirmSetup: (...args: unknown[]) => Promise<unknown>;
    },
  },
}));

// ONE router object for the whole file, like Next's real `useRouter()` (a
// stable instance). A fresh object per render re-fired CheckoutForm's
// `[router]` mount effect on every re-render and re-POSTed mid-flow.
const stableRouter = { push: pushMock, replace: replaceMock };
vi.mock("next/navigation", () => ({
  useRouter: () => stableRouter,
  redirect: (...args: unknown[]) => {
    // CheckoutPage is tested in its own describe with a dedicated redirect mock.
    throw new Error(`redirect:${JSON.stringify(args)}`);
  },
}));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn(async () => null),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div data-testid="elements-stub">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element-stub" />,
  useStripe: () => stripeRef.current,
  useElements: () => (stripeRef.current ? {} : null),
}));

import { CheckoutForm } from "@/app/(member)/checkout/checkout-form";

function mockFetch(body: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn((_input?: string | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok,
      status,
      json: async () => body,
    }),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// A GATED fetch mock for the setup-then-start flow: EVERY call answers with
// `ready` until the test calls `advance()` (from inside the `confirmSetup`
// mock, once the card is "saved"), after which every call answers with
// `after`. Call-COUNT based sequencing is not safe here — the mocked
// `useRouter()` returns a fresh object on every render (`() => ({ push,
// replace })`), and the mount effect's `[router]` dependency array re-fires
// it on every re-render the mount fetch itself causes (each `setState` call
// re-renders, which re-creates `router`), so the mount POST can legitimately
// fire more than once before the button is ever clicked. A GATE is immune to
// that: every one of those extra mount calls just gets `ready` again, exactly
// like the real (idempotent) route would answer.
function mockFetchGate(
  ready: { ok?: boolean; status?: number; body: unknown },
  after: { ok?: boolean; status?: number; body: unknown },
) {
  let advanced = false;
  const fetchMock = vi.fn(() => {
    const r = advanced ? after : ready;
    return Promise.resolve({ ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.body });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, advance: () => { advanced = true; } };
}

// MOCK route-response fixtures — Pricing v2 (ENG-1328). unitAmount 999 aud
// mirrors the sandbox's A$9.99 price; these are NOT application constants.
const NON_TRIAL = {
  started: false,
  clientSecret: null as string | null,
  intentType: "payment",
  publishableKey: null as string | null,
  mode: "subscribe",
  unitAmount: 999,
  amountDueNow: 999,
  currency: "aud",
  trialEndsAt: null as string | null,
  priceChangesOn: null,
};

const TRIAL = {
  started: false,
  clientSecret: null as string | null,
  intentType: "setup",
  publishableKey: null as string | null,
  mode: "subscribe",
  unitAmount: 999,
  amountDueNow: 0,
  currency: "aud",
  trialEndsAt: "2026-10-23T03:00:00.000Z",
  priceChangesOn: null,
};

describe("CheckoutForm", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pushMock.mockClear();
    replaceMock.mockClear();
    assignMock.mockClear();
    vi.stubGlobal("location", { origin: "http://localhost:3000", assign: assignMock });
    stripeRef.current = null;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("posts to /api/subscription/checkout on mount with no body (no card data is ever posted)", async () => {
    const fetchMock = mockFetch(
      { error: { code: "stripe_unavailable", message: "Payment provider not configured." } },
      false,
      502,
    );

    render(<CheckoutForm />);
    await screen.findByText("Order summary");

    expect(fetchMock).toHaveBeenCalledWith("/api/subscription/checkout", { method: "POST" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBeUndefined();
  });

  it("trial response: A$0.00 today, Free until <date>, then A$9.99 per month, GST A$0.00", async () => {
    mockFetch({ data: TRIAL });

    render(<CheckoutForm />);

    await screen.findByText("Order summary");
    expect(document.body.textContent).toMatch(/A\$0\.00 today/);
    expect(document.body.textContent).toMatch(/Free until 23 October 2026/);
    expect(document.body.textContent).toMatch(/then A\$9\.99 per month/);
    const total = screen.getByText("Total today").closest(".summary-line");
    expect(total?.textContent).toContain("A$0.00");
    expect(screen.getByText("Includes GST").closest(".summary-line")?.textContent).toContain("A$0.00");
  });

  it("non-trial response: A$9.99 today, then A$9.99 per month, no Free trial text anywhere", async () => {
    mockFetch({ data: NON_TRIAL });

    render(<CheckoutForm />);

    await screen.findByTestId("pricing-band");
    expect(document.body.textContent).toMatch(/A\$9\.99 today, then A\$9\.99 per month/);
    expect(document.body.textContent).not.toMatch(/Free trial/);
  });

  it("order summary states a monthly subscription and renews monthly for a non-trial response", async () => {
    mockFetch({ data: NON_TRIAL });

    render(<CheckoutForm />);

    expect(await screen.findByText("Subscription · monthly")).toBeInTheDocument();
    expect(screen.getByText("Includes GST")).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/renews monthly/i);
    expect(screen.queryByText("30 days of full access")).not.toBeInTheDocument();
    expect(screen.queryByTestId("summary-trial")).not.toBeInTheDocument();
  });

  it("409 already_active redirects to /account — no renewal path remains", async () => {
    mockFetch({ error: { code: "already_active", message: "You already have an active subscription." } }, false, 409);

    render(<CheckoutForm />);

    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith("/account"));
    expect(document.body.textContent).not.toMatch(/Your access currently ends/);
    expect(document.body.textContent).not.toMatch(/Paying now extends it/);
  });

  it("stripe-unavailable (502, no data): renders the disabled placeholder, not a crash", async () => {
    mockFetch({ error: { code: "stripe_unavailable", message: "Payment provider not configured." } }, false, 502);

    render(<CheckoutForm />);

    expect(await screen.findByText(/Payments are not configured yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Subscribe/ })).toBeDisabled();
    expect(screen.getByText("Order summary")).toBeInTheDocument();
  });

  it("200 with a null clientSecret renders an ERROR state, never the configuration hint, and logs", async () => {
    mockFetch({
      data: { ...NON_TRIAL, clientSecret: null, publishableKey: "pk_test_dummy" },
    });

    render(<CheckoutForm />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t start a secure payment/i);
    expect(document.body.textContent).not.toMatch(/not configured/i);
    expect(document.body.textContent).not.toMatch(/Stripe key/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("502 stripe_unavailable renders the configuration message and NOT the error alert", async () => {
    mockFetch({ error: { code: "stripe_unavailable", message: "Payment provider not configured." } }, false, 502);

    render(<CheckoutForm />);

    expect(await screen.findByText(/Payments are not configured yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a non-502 failure renders the error state, not a configuration hint", async () => {
    mockFetch({ error: { code: "server_error", message: "boom" } }, false, 500);

    render(<CheckoutForm />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t start a secure payment/i);
    expect(document.body.textContent).not.toMatch(/not configured/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("the misleading 'connect a Stripe key' copy is gone for every not-ready state", async () => {
    mockFetch({ error: { code: "stripe_unavailable", message: "Payment provider not configured." } }, false, 502);
    const { unmount } = render(<CheckoutForm />);
    await screen.findByText(/Payments are not configured yet/i);
    expect(document.body.textContent).not.toMatch(/connect a Stripe key/i);
    unmount();

    mockFetch({
      data: { ...NON_TRIAL, clientSecret: null, publishableKey: "pk_test_dummy" },
    });
    render(<CheckoutForm />);
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toMatch(/connect a Stripe key/i);
  });

  it("502 with a NON-configuration code (stripe_error) renders the error state, not the config hint", async () => {
    mockFetch({ error: { code: "stripe_error", message: "Payment provider unavailable." } }, false, 502);

    render(<CheckoutForm />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t start a secure payment/i);
    expect(document.body.textContent).not.toMatch(/not configured/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("a network failure renders the error state and logs — never the configuration hint", async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    render(<CheckoutForm />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t start a secure payment/i);
    expect(document.body.textContent).not.toMatch(/not configured/i);
    expect(document.body.textContent).not.toMatch(/connect a Stripe key/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("while the POST is still in flight it shows the neutral loading copy — no error, no config hint", async () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    render(<CheckoutForm />);

    expect(await screen.findByText(/Preparing secure payment/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/not configured/i);
    expect(document.body.textContent).not.toMatch(/connect a Stripe key/i);
  });

  it("never renders a raw card-number/CVC input", async () => {
    mockFetch({ error: { code: "stripe_unavailable", message: "n/a" } }, false, 502);

    render(<CheckoutForm />);
    await screen.findByText("Order summary");

    expect(screen.queryByPlaceholderText("1234 1234 1234 1234")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("123")).not.toBeInTheDocument();
  });

  it("pay button label reads 'Subscribe · A$9.99' for a non-trial response, not a 30-day Pay label", async () => {
    mockFetch({ data: NON_TRIAL });

    render(<CheckoutForm />);

    expect(await screen.findByRole("button", { name: "Subscribe · A$9.99" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /30 days/ })).not.toBeInTheDocument();
  });

  it("pay button label reads 'Start free trial · A$0.00 today' for a trial response", async () => {
    mockFetch({ data: TRIAL });

    render(<CheckoutForm />);

    expect(await screen.findByRole("button", { name: "Start free trial · A$0.00 today" })).toBeInTheDocument();
  });

  it("the Subscribe button disables on the first submit so a double-click cannot double-charge", async () => {
    let release: (v: unknown) => void = () => {};
    const confirmPayment = vi.fn(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const confirmSetup = vi.fn(async () => ({}));
    stripeRef.current = { confirmPayment, confirmSetup };

    mockFetch({
      data: { ...NON_TRIAL, clientSecret: "pi_sub_secret", publishableKey: "pk_test_dummy" },
    });

    render(<CheckoutForm />);

    expect(await screen.findByTestId("payment-element-stub")).toBeInTheDocument();

    const payButton = await screen.findByRole("button", { name: "Subscribe · A$9.99" });
    expect(payButton).toBeEnabled();

    fireEvent.click(payButton);

    await waitFor(() => expect(screen.getByRole("button", { name: "Unlocking…" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Unlocking…" }));
    expect(confirmPayment).toHaveBeenCalledTimes(1);
    expect(confirmSetup).not.toHaveBeenCalled();
    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmParams: { return_url: "http://localhost:3000/explore?paid=1" },
        redirect: "if_required",
      }),
    );

    release({});
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/explore"));
    expect(pushMock).not.toHaveBeenCalled();
    expect(confirmPayment).toHaveBeenCalledTimes(1);
  });

  it("a failed confirmPayment shows an inline error, stays on the page and re-enables the button", async () => {
    const confirmPayment = vi.fn(async () => ({ error: { message: "Your card was declined." } }));
    const confirmSetup = vi.fn(async () => ({}));
    stripeRef.current = { confirmPayment, confirmSetup };

    mockFetch({
      data: { ...NON_TRIAL, clientSecret: "pi_sub_secret", publishableKey: "pk_test_dummy" },
    });

    render(<CheckoutForm />);

    fireEvent.click(await screen.findByRole("button", { name: "Subscribe · A$9.99" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your card was declined.");
    expect(pushMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Subscribe · A$9.99" })).toBeEnabled());
  });
});

describe("ENG-1328 — the free-trial / recurring band", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pushMock.mockClear();
    replaceMock.mockClear();
    assignMock.mockClear();
    vi.stubGlobal("location", { origin: "http://localhost:3000", assign: assignMock });
    stripeRef.current = null;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("a trial response renders the 'Free trial' band with today's A$0.00 and the standard per-month price", async () => {
    mockFetch({ data: TRIAL });

    render(<CheckoutForm />);

    const band = await screen.findByTestId("pricing-band");
    expect(band.textContent).toMatch(/Free until 23 October 2026/);
    expect(band.textContent).toMatch(/A\$9\.99 per month/);
    expect(screen.getAllByText("Free trial").length).toBeGreaterThan(0);
  });

  it("a non-trial response renders the 'Monthly membership' band, not the free-trial band", async () => {
    mockFetch({ data: NON_TRIAL });

    render(<CheckoutForm />);

    const band = await screen.findByTestId("pricing-band");
    expect(screen.getByText("Monthly membership")).toBeInTheDocument();
    expect(band.textContent).toMatch(/A\$9\.99 today, then A\$9\.99 per month/);
    expect(screen.queryByText("Free trial")).not.toBeInTheDocument();
  });

  it("no usable pricing (unitAmount missing): no band renders (callout still states the recurring charge)", async () => {
    mockFetch({
      data: { clientSecret: null, publishableKey: null, mode: "subscribe" },
    });

    render(<CheckoutForm />);

    await screen.findByText("Order summary");
    expect(screen.queryByTestId("pricing-band")).not.toBeInTheDocument();
    expect(document.body.textContent).toMatch(/renews monthly/i);
  });

  it("a degraded response with trialEndsAt as a non-string renders the non-trial band, never 'NaN'", async () => {
    mockFetch({
      data: {
        clientSecret: null,
        publishableKey: null,
        mode: "subscribe",
        unitAmount: 999,
        currency: "aud",
        amountDueNow: 999,
        trialEndsAt: 12345,
      },
    });

    render(<CheckoutForm />);

    await screen.findByTestId("pricing-band");
    expect(screen.getByText("Monthly membership")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("the band's label/detail are nested INSIDE .trial-banner-web, not siblings", async () => {
    mockFetch({ data: TRIAL });

    const { container } = render(<CheckoutForm />);
    await screen.findByTestId("pricing-band");

    expect(container.querySelector(".trial-banner-web")).not.toBeNull();
    expect(container.querySelector(".trial-banner-web .trial-label")).not.toBeNull();
    expect(container.querySelector(".trial-banner-web .trial-detail")).not.toBeNull();
  });

  it("never sends any allowance: the POST carries no body", async () => {
    const fetchMock = mockFetch({ data: TRIAL });

    render(<CheckoutForm />);
    await screen.findByTestId("pricing-band");

    expect(fetchMock).toHaveBeenCalledWith("/api/subscription/checkout", { method: "POST" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBeUndefined();
  });

  it("no trial copy survives on the screen after a non-trial subscribe response", async () => {
    mockFetch({ data: NON_TRIAL });

    render(<CheckoutForm />);
    await screen.findByTestId("pricing-band");

    expect(document.body.textContent).not.toMatch(/trial/i);
  });

  it("intentType 'setup' calls confirmSetup, not confirmPayment, with return_url ending /checkout?setup=1", async () => {
    const confirmPayment = vi.fn(async () => ({}));
    const { advance } = mockFetchGate(
      { body: { data: { ...TRIAL, clientSecret: "seti_1_secret", publishableKey: "pk_test_dummy" } } },
      { body: { data: { started: true } } },
    );
    const confirmSetup = vi.fn(async () => {
      advance();
      return {};
    });
    stripeRef.current = { confirmPayment, confirmSetup };

    render(<CheckoutForm />);

    fireEvent.click(await screen.findByRole("button", { name: "Start free trial · A$0.00 today" }));

    await waitFor(() => expect(confirmSetup).toHaveBeenCalledTimes(1));
    expect(confirmPayment).not.toHaveBeenCalled();
    expect(confirmSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmParams: { return_url: "http://localhost:3000/checkout?setup=1" },
        redirect: "if_required",
      }),
    );
    // Let the rest of onPay's chain (the post-confirm POST, waitForEntitled,
    // the navigate) finish INSIDE this test — an in-flight async tail here
    // would otherwise consume the NEXT test's fetch mock queue.
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/explore"));
  });

  it("intentType 'payment' calls confirmPayment, not confirmSetup, with return_url ending /explore?paid=1", async () => {
    const confirmPayment = vi.fn(async () => ({}));
    const confirmSetup = vi.fn(async () => ({}));
    stripeRef.current = { confirmPayment, confirmSetup };

    mockFetch({
      data: { ...NON_TRIAL, clientSecret: "pi_sub_secret", publishableKey: "pk_test_dummy" },
    });

    render(<CheckoutForm />);

    fireEvent.click(await screen.findByRole("button", { name: "Subscribe · A$9.99" }));

    await waitFor(() => expect(confirmPayment).toHaveBeenCalledTimes(1));
    expect(confirmSetup).not.toHaveBeenCalled();
    expect(confirmPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmParams: { return_url: "http://localhost:3000/explore?paid=1" },
        redirect: "if_required",
      }),
    );
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/explore"));
  });

  // A trial is CARD FIRST (ENG-1328): confirmSetup only SAVES the card. The
  // screen must then POST the route again to actually start the trial, and
  // only navigate once THAT reports `started: true`.
  it("setup-intent confirm success starts the trial via a second POST, then waits for entitlement and navigates", async () => {
    const { fetchMock, advance } = mockFetchGate(
      { body: { data: { ...TRIAL, clientSecret: "seti_1_secret", publishableKey: "pk_test_dummy" } } },
      { body: { data: { started: true } } },
    );
    const confirmSetup = vi.fn(async () => {
      advance();
      return {};
    });
    stripeRef.current = { confirmPayment: vi.fn(), confirmSetup };

    render(<CheckoutForm />);

    fireEvent.click(await screen.findByRole("button", { name: "Start free trial · A$0.00 today" }));

    await waitFor(() => expect(confirmSetup).toHaveBeenCalledTimes(1));
    // A second call to the SAME route, after the card is confirmed, is what
    // actually starts the trial (CARD FIRST, ENG-1328).
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/explore"));
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("setup-intent confirm success but the trial fails to start: inline error, no navigation, button re-enables", async () => {
    const { advance } = mockFetchGate(
      { body: { data: { ...TRIAL, clientSecret: "seti_1_secret", publishableKey: "pk_test_dummy" } } },
      { ok: false, status: 502, body: { error: { code: "stripe_error", message: "Payment provider unavailable." } } },
    );
    const confirmSetup = vi.fn(async () => {
      advance();
      return {};
    });
    stripeRef.current = { confirmPayment: vi.fn(), confirmSetup };

    render(<CheckoutForm />);

    fireEvent.click(await screen.findByRole("button", { name: "Start free trial · A$0.00 today" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't start your free trial/i);
    expect(assignMock).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start free trial · A$0.00 today" })).toBeEnabled(),
    );
  });

  it("setup-intent confirm then 409 already_active (a second tab started the trial first) proceeds like started:true", async () => {
    let advanced = false;
    const advance = () => {
      advanced = true;
    };
    // The checkout route answers 409 after the confirm; the entitlement poll
    // (any other URL) answers 200 — the trial is running.
    global.fetch = vi.fn((input: unknown) => {
      const url = String(input);
      const r = !url.includes("/api/subscription/checkout")
        ? { ok: true, status: 200, body: { data: [] } }
        : advanced
          ? { ok: false, status: 409, body: { error: { code: "already_active", message: "You already have an active subscription." } } }
          : { ok: true, status: 200, body: { data: { ...TRIAL, clientSecret: "seti_1_secret", publishableKey: "pk_test_dummy" } } };
      return Promise.resolve({ ok: r.ok, status: r.status, json: async () => r.body });
    }) as unknown as typeof fetch;
    const confirmSetup = vi.fn(async () => {
      advance();
      return {};
    });
    stripeRef.current = { confirmPayment: vi.fn(), confirmSetup };

    render(<CheckoutForm />);

    fireEvent.click(await screen.findByRole("button", { name: "Start free trial · A$0.00 today" }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/explore"));
    expect(screen.queryByText(/couldn't start your free trial/i)).toBeNull();
  });

  // A load that finds the card already saved (a redirect-based method
  // returning to /checkout?setup=1, or a tab closed mid-way) gets
  // `started: true` on the FIRST POST — no Elements, no confirm at all.
  it("on-mount response with started:true shows 'Starting your free trial…', waits for entitlement and navigates, no Elements mounted", async () => {
    mockFetch({ data: { ...TRIAL, started: true } });

    render(<CheckoutForm />);

    expect(await screen.findByText(/Starting your free trial…/)).toBeInTheDocument();
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/explore"));
    expect(screen.queryByTestId("payment-element-stub")).not.toBeInTheDocument();
    expect(screen.queryByTestId("elements-stub")).not.toBeInTheDocument();
  });
});
