import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Kept light per the ticket: this exercises the mount → POST /api/subscription/checkout
// → purchase/renewal/graceful-placeholder paths, not a live Stripe Elements mount.
// @stripe/stripe-js and @stripe/react-stripe-js are stubbed so importing
// checkout-form.tsx doesn't try to load the real Stripe.js script in jsdom.
// `stripeRef.current` is mutable so a test can swap in a real-ish Stripe stub and
// actually render <PayForm> — with `useStripe: () => null` hard-coded, onPay
// early-returns and the double-submit guard can never be exercised.
const { pushMock, stripeRef } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  stripeRef: { current: null as null | { confirmPayment: (...args: unknown[]) => Promise<unknown> } },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
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

// The component reads `body.data` even on a NON-ok response (so the order
// summary can still show the real price) — every fetch mock below therefore
// provides a `json()`, ok or not.
// The params are declared (rather than `vi.fn(() => ...)`) so `mock.calls[0]`
// types as a 2-tuple — without them `const [, init] = fetchMock.mock.calls[0]`
// below fails `tsc --noEmit` even though vitest still runs it.
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

describe("CheckoutForm", () => {
  // The component now logs on EVERY not-ready path (that loud logging is the
  // point of ENG-581). Several tests below deliberately drive those paths while
  // asserting something else entirely, so silence console.error suite-wide
  // rather than letting real failures drown in expected noise. Tests that assert
  // on logging install their own spy on top, which still records calls.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pushMock.mockClear();
    stripeRef.current = null;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("posts to /api/subscription/checkout on mount with no body (no card data is ever posted)", async () => {
    const fetchMock = mockFetch(
      { error: { code: "stripe_unavailable", message: "Payment provider not configured." } },
      false,
      502,
    );

    render(<CheckoutForm trialDaysLeft={12} />);
    await screen.findByText("Order summary");

    expect(fetchMock).toHaveBeenCalledWith("/api/subscription/checkout", { method: "POST" });
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBeUndefined();
  });

  it("purchase mode: renders A$1.00 total and A$0.09 GST for unitAmount 100", async () => {
    mockFetch({
      data: { clientSecret: null, publishableKey: null, mode: "purchase", unitAmount: 100, currency: "aud" },
    });

    render(<CheckoutForm trialDaysLeft={12} />);

    expect((await screen.findAllByText("A$1.00")).length).toBeGreaterThan(0);
    expect(screen.getByText("A$0.09")).toBeInTheDocument();
  });

  it("purchase mode: renders A$19.00 total and A$1.73 GST for unitAmount 1900 (anti-hardcode)", async () => {
    mockFetch({
      data: { clientSecret: null, publishableKey: null, mode: "purchase", unitAmount: 1900, currency: "aud" },
    });

    render(<CheckoutForm trialDaysLeft={12} />);

    expect((await screen.findAllByText("A$19.00")).length).toBeGreaterThan(0);
    expect(screen.getByText("A$1.73")).toBeInTheDocument();
  });

  it("order summary copy: '30 days of full access' + 'Includes GST', never monthly-subscription language", async () => {
    mockFetch({
      data: { clientSecret: null, publishableKey: null, mode: "purchase", unitAmount: 1900, currency: "aud" },
    });

    render(<CheckoutForm trialDaysLeft={12} />);

    expect(await screen.findByText("30 days of full access")).toBeInTheDocument();
    expect(screen.getByText("Includes GST")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/renews monthly/i);
    expect(document.body.textContent).not.toMatch(/Subscription · monthly/i);
  });

  it("renewal mode: renders the extend copy with both authoritative dates", async () => {
    mockFetch({
      data: {
        mode: "renewal",
        unitAmount: 100,
        currency: "aud",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        newPeriodEnd: "2026-10-01T00:00:00.000Z",
        clientSecret: null,
        publishableKey: null,
      },
    });

    render(<CheckoutForm trialDaysLeft={0} />);

    expect(await screen.findByText(/Your access currently ends/)).toBeInTheDocument();
    expect(screen.getByText(/1 September 2026/)).toBeInTheDocument();
    expect(screen.getByText(/1 October 2026/)).toBeInTheDocument();
  });

  it("stripe-unavailable (502, no data): renders the disabled placeholder, not a crash", async () => {
    mockFetch({ error: { code: "stripe_unavailable", message: "Payment provider not configured." } }, false, 502);

    render(<CheckoutForm trialDaysLeft={12} />);

    expect(await screen.findByText(/Payments are not configured yet/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pay/ })).toBeDisabled();
    expect(screen.getByText("Order summary")).toBeInTheDocument();
  });

  it("200 with a null clientSecret renders an ERROR state, never the configuration hint, and logs", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({
      data: { clientSecret: null, publishableKey: "pk_test_dummy", mode: "purchase", unitAmount: 100, currency: "aud" },
    });

    render(<CheckoutForm trialDaysLeft={12} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t start a secure payment/i);
    expect(document.body.textContent).not.toMatch(/not configured/i);
    expect(document.body.textContent).not.toMatch(/Stripe key/i);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("502 stripe_unavailable renders the configuration message and NOT the error alert", async () => {
    mockFetch({ error: { code: "stripe_unavailable", message: "Payment provider not configured." } }, false, 502);

    render(<CheckoutForm trialDaysLeft={12} />);

    expect(await screen.findByText(/Payments are not configured yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a non-502 failure renders the error state, not a configuration hint", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({ error: { code: "server_error", message: "boom" } }, false, 500);

    render(<CheckoutForm trialDaysLeft={12} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t start a secure payment/i);
    expect(document.body.textContent).not.toMatch(/not configured/i);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("the misleading 'connect a Stripe key' copy is gone for every not-ready state", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockFetch({ error: { code: "stripe_unavailable", message: "Payment provider not configured." } }, false, 502);
    const { unmount } = render(<CheckoutForm trialDaysLeft={12} />);
    await screen.findByText(/Payments are not configured yet/i);
    expect(document.body.textContent).not.toMatch(/connect a Stripe key/i);
    unmount();

    mockFetch({
      data: { clientSecret: null, publishableKey: "pk_test_dummy", mode: "purchase", unitAmount: 100, currency: "aud" },
    });
    render(<CheckoutForm trialDaysLeft={12} />);
    await screen.findByRole("alert");
    expect(document.body.textContent).not.toMatch(/connect a Stripe key/i);

    consoleErrorSpy.mockRestore();
  });

  // A 502 is NOT automatically a configuration problem. Only the route's
  // `stripe_unavailable` (no STRIPE_SECRET_KEY) is; a Stripe outage / bad price
  // id now returns `stripe_error` and must read as a real error.
  it("502 with a NON-configuration code (stripe_error) renders the error state, not the config hint", async () => {
    mockFetch({ error: { code: "stripe_error", message: "Payment provider unavailable." } }, false, 502);

    render(<CheckoutForm trialDaysLeft={12} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t start a secure payment/i);
    expect(document.body.textContent).not.toMatch(/not configured/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("a network failure renders the error state and logs — never the configuration hint", async () => {
    // The server was never reached, so we know NOTHING about whether a key
    // exists; claiming a configuration problem here would be a guess.
    global.fetch = vi.fn(() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;

    render(<CheckoutForm trialDaysLeft={12} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t start a secure payment/i);
    expect(document.body.textContent).not.toMatch(/not configured/i);
    expect(document.body.textContent).not.toMatch(/connect a Stripe key/i);
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it("while the POST is still in flight it shows the neutral loading copy — no error, no config hint", async () => {
    // A never-resolving fetch pins the initial paint. Flashing either an error
    // or "not configured" before the answer arrives is a lie in both directions.
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;

    render(<CheckoutForm trialDaysLeft={12} />);

    expect(await screen.findByText(/Preparing secure payment/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/not configured/i);
    expect(document.body.textContent).not.toMatch(/connect a Stripe key/i);
  });

  it("never renders a raw card-number/CVC input", async () => {
    mockFetch({ error: { code: "stripe_unavailable", message: "n/a" } }, false, 502);

    render(<CheckoutForm trialDaysLeft={5} />);
    await screen.findByText("Order summary");

    expect(screen.queryByPlaceholderText("1234 1234 1234 1234")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("123")).not.toBeInTheDocument();
  });

  it("pay button label reads 'Pay A$1.00 · 30 days', not 'Subscribe'", async () => {
    mockFetch({
      data: { clientSecret: null, publishableKey: null, mode: "purchase", unitAmount: 100, currency: "aud" },
    });

    render(<CheckoutForm trialDaysLeft={12} />);

    expect(await screen.findByRole("button", { name: "Pay A$1.00 · 30 days" })).toBeInTheDocument();
  });

  // The double-CHARGE guard, exercised on the real <PayForm> (not the disabled
  // placeholder). Two concurrent renewal PaymentIntents would each stamp the same
  // absolute new_period_end, so the member would pay twice for one extension —
  // the advance-only rule makes the extension idempotent but NOT the charge.
  it("renewal: the Pay button disables on the first submit so a double-click cannot double-charge", async () => {
    let release: (v: unknown) => void = () => {};
    const confirmPayment = vi.fn(
      () => new Promise((resolve) => { release = resolve; }),
    );
    stripeRef.current = { confirmPayment };

    mockFetch({
      data: {
        clientSecret: "pi_renew_secret",
        publishableKey: "pk_test_dummy",
        mode: "renewal",
        unitAmount: 100,
        currency: "aud",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        newPeriodEnd: "2026-10-01T00:00:00.000Z",
      },
    });

    render(<CheckoutForm trialDaysLeft={0} />);

    // The live Payment Element mounts — proving this is PayForm, not the placeholder.
    expect(await screen.findByTestId("payment-element-stub")).toBeInTheDocument();

    const payButton = await screen.findByRole("button", { name: "Pay A$1.00 · 30 days" });
    expect(payButton).toBeEnabled();

    fireEvent.click(payButton);

    // In flight: disabled, and a second click must not reach Stripe again.
    await waitFor(() => expect(screen.getByRole("button", { name: "Processing…" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Processing…" }));
    expect(confirmPayment).toHaveBeenCalledTimes(1);

    release({});
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/explore"));
    expect(confirmPayment).toHaveBeenCalledTimes(1);
  });

  it("renewal: a failed confirmPayment shows an inline error, stays on the page and re-enables the button", async () => {
    const confirmPayment = vi.fn(async () => ({ error: { message: "Your card was declined." } }));
    stripeRef.current = { confirmPayment };

    mockFetch({
      data: {
        clientSecret: "pi_renew_secret",
        publishableKey: "pk_test_dummy",
        mode: "renewal",
        unitAmount: 100,
        currency: "aud",
        currentPeriodEnd: "2026-09-01T00:00:00.000Z",
        newPeriodEnd: "2026-10-01T00:00:00.000Z",
      },
    });

    render(<CheckoutForm trialDaysLeft={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "Pay A$1.00 · 30 days" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your card was declined.");
    expect(pushMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Pay A$1.00 · 30 days" })).toBeEnabled());
  });
});
