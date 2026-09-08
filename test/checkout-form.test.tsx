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
  stripeRef: { current: null as null | { confirmPayment: (...args: unknown[]) => Promise<unknown> } },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
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

const INTRO = {
  clientSecret: null,
  publishableKey: null,
  mode: "subscribe",
  unitAmount: 1900,
  discountAmount: 1000,
  amountDueNow: 900,
  currency: "aud",
  introMonthsRemaining: 6,
  priceChangesOn: "March 2027",
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

  it("subscribe intro: list price A$19.00, due today A$9.00, GST from amountDueNow", async () => {
    mockFetch({ data: INTRO });

    render(<CheckoutForm />);

    expect((await screen.findAllByText("A$19.00")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("A$9.00").length).toBeGreaterThan(0);
    // 900 / 11 → A$0.82
    expect(screen.getByText("A$0.82")).toBeInTheDocument();
    expect(screen.getByText("−A$10.00")).toBeInTheDocument();
  });

  it("subscribe standard: unitAmount 1900 with no discount shows A$19.00 today and A$1.73 GST", async () => {
    mockFetch({
      data: {
        ...INTRO,
        discountAmount: 0,
        amountDueNow: 1900,
        introMonthsRemaining: 0,
        priceChangesOn: null,
      },
    });

    render(<CheckoutForm />);

    expect((await screen.findAllByText("A$19.00")).length).toBeGreaterThan(0);
    expect(screen.getByText("A$1.73")).toBeInTheDocument();
    expect(screen.queryByText("−A$10.00")).not.toBeInTheDocument();
  });

  it("order summary states a monthly subscription and when the price changes", async () => {
    mockFetch({ data: INTRO });

    render(<CheckoutForm />);

    expect(await screen.findByText("Subscription · monthly")).toBeInTheDocument();
    expect(screen.getByText("Includes GST")).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/renews monthly/i);
    expect(document.body.textContent).toMatch(/A\$9\.00 today, then A\$19\.00/);
    expect(document.body.textContent).not.toMatch(/from March 2027/);
    expect(screen.queryByText("30 days of full access")).not.toBeInTheDocument();
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
      data: { ...INTRO, clientSecret: null, publishableKey: "pk_test_dummy" },
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
      data: { ...INTRO, clientSecret: null, publishableKey: "pk_test_dummy" },
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

  it("pay button label reads 'Subscribe · A$9.00', not a 30-day Pay label", async () => {
    mockFetch({ data: INTRO });

    render(<CheckoutForm />);

    expect(await screen.findByRole("button", { name: "Subscribe · A$9.00" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /30 days/ })).not.toBeInTheDocument();
  });

  it("the Subscribe button disables on the first submit so a double-click cannot double-charge", async () => {
    let release: (v: unknown) => void = () => {};
    const confirmPayment = vi.fn(
      () => new Promise((resolve) => { release = resolve; }),
    );
    stripeRef.current = { confirmPayment };

    mockFetch({
      data: { ...INTRO, clientSecret: "pi_sub_secret", publishableKey: "pk_test_dummy" },
    });

    render(<CheckoutForm />);

    expect(await screen.findByTestId("payment-element-stub")).toBeInTheDocument();

    const payButton = await screen.findByRole("button", { name: "Subscribe · A$9.00" });
    expect(payButton).toBeEnabled();

    fireEvent.click(payButton);

    await waitFor(() => expect(screen.getByRole("button", { name: "Unlocking…" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Unlocking…" }));
    expect(confirmPayment).toHaveBeenCalledTimes(1);
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
    stripeRef.current = { confirmPayment };

    mockFetch({
      data: { ...INTRO, clientSecret: "pi_sub_secret", publishableKey: "pk_test_dummy" },
    });

    render(<CheckoutForm />);

    fireEvent.click(await screen.findByRole("button", { name: "Subscribe · A$9.00" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your card was declined.");
    expect(pushMock).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Subscribe · A$9.00" })).toBeEnabled());
  });
});

describe("ENG-1027 — the introductory / recurring band", () => {
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

  it("introMonthsRemaining: 6 renders the introductory band with both prices and no calendar date", async () => {
    mockFetch({ data: INTRO });

    render(<CheckoutForm />);

    expect(await screen.findByText("Introductory pricing")).toBeInTheDocument();
    expect(screen.getByText(/A\$9\.00 today, then A\$19\.00/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/from March 2027/);
    expect(screen.getByText(/6 introductory months remain/)).toBeInTheDocument();
    expect(screen.getByText(/Charged monthly until you cancel/)).toBeInTheDocument();
  });

  it("introMonthsRemaining: 1 reads 'the last month at the introductory rate'", async () => {
    mockFetch({
      data: { ...INTRO, introMonthsRemaining: 1, priceChangesOn: "October 2026" },
    });

    render(<CheckoutForm />);

    expect(await screen.findByText(/last month at the introductory rate/)).toBeInTheDocument();
  });

  it("introMonthsRemaining: 0 renders 'Standard pricing' at the list amount, not the introductory band", async () => {
    mockFetch({
      data: {
        ...INTRO,
        discountAmount: 0,
        amountDueNow: 1900,
        introMonthsRemaining: 0,
        priceChangesOn: null,
      },
    });

    render(<CheckoutForm />);

    expect(await screen.findByText("Standard pricing")).toBeInTheDocument();
    expect(screen.getAllByText(/A\$19\.00/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Introductory pricing")).not.toBeInTheDocument();
  });

  it("no introMonthsRemaining key at all: no band renders (callout still states the recurring charge)", async () => {
    mockFetch({
      data: { clientSecret: null, publishableKey: null, mode: "subscribe", unitAmount: 1900, currency: "aud" },
    });

    render(<CheckoutForm />);

    await screen.findByText("Order summary");
    expect(screen.queryByText("Introductory pricing")).not.toBeInTheDocument();
    expect(screen.queryByText("Standard pricing")).not.toBeInTheDocument();
    expect(document.body.textContent).toMatch(/renews monthly/i);
  });

  it("a degraded response with introMonthsRemaining as a string renders no band and never 'NaN'", async () => {
    mockFetch({
      data: {
        clientSecret: null,
        publishableKey: null,
        mode: "subscribe",
        unitAmount: 1900,
        currency: "aud",
        introMonthsRemaining: "6",
      },
    });

    render(<CheckoutForm />);

    await screen.findByText("Order summary");
    expect(screen.queryByText("Introductory pricing")).not.toBeInTheDocument();
    expect(screen.queryByText("Standard pricing")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN/);
  });

  it("the band's label/detail are nested INSIDE .trial-banner-web, not siblings", async () => {
    mockFetch({ data: INTRO });

    const { container } = render(<CheckoutForm />);
    await screen.findByText("Introductory pricing");

    expect(container.querySelector(".trial-banner-web")).not.toBeNull();
    expect(container.querySelector(".trial-banner-web .trial-label")).not.toBeNull();
    expect(container.querySelector(".trial-banner-web .trial-detail")).not.toBeNull();
  });

  it("never sends the allowance: the POST carries no body", async () => {
    const fetchMock = mockFetch({ data: INTRO });

    render(<CheckoutForm />);
    await screen.findByText("Introductory pricing");

    expect(fetchMock).toHaveBeenCalledWith("/api/subscription/checkout", { method: "POST" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBeUndefined();
  });

  it("no trial copy survives on the screen after a subscribe-mode response", async () => {
    mockFetch({ data: INTRO });

    render(<CheckoutForm />);
    await screen.findByText("Introductory pricing");

    expect(document.body.textContent).not.toMatch(/trial/i);
  });
});
