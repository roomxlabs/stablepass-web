import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Kept light per the ticket: this exercises the mount → POST /api/subscription/checkout
// → graceful-placeholder path (the no-real-Stripe-keys case in this environment), not a
// live Stripe Elements mount. @stripe/stripe-js and @stripe/react-stripe-js are stubbed
// so importing checkout-form.tsx doesn't try to load the real Stripe.js script in jsdom.
const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn(async () => null),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div data-testid="elements-stub">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element-stub" />,
  useStripe: () => null,
  useElements: () => null,
}));

import { CheckoutForm } from "@/app/(member)/checkout/checkout-form";

describe("CheckoutForm", () => {
  beforeEach(() => {
    pushMock.mockClear();
  });

  it("posts to /api/subscription/checkout on mount and renders the order summary + a Pay affordance (graceful placeholder, no Stripe keys)", async () => {
    const fetchMock = vi.fn((_input?: string | URL, _init?: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: async () => ({ error: { code: "stripe_unavailable", message: "Payment provider not configured." } }),
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CheckoutForm trialDaysLeft={12} />);

    expect(fetchMock).toHaveBeenCalledWith("/api/subscription/checkout", { method: "POST" });
    // No raw card fields are ever posted to any /api/* route — the checkout
    // POST carries no body at all.
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.body).toBeUndefined();

    expect(await screen.findByText("Order summary")).toBeInTheDocument();
    expect(screen.getByText("Full access")).toBeInTheDocument();
    const payButton = screen.getByRole("button", { name: /Subscribe/ });
    expect(payButton).toBeDisabled();

    // The graceful "connect a Stripe key" placeholder, not a live PaymentElement.
    expect(screen.getByText(/connect a Stripe key to enable checkout/i)).toBeInTheDocument();
    expect(screen.queryByTestId("payment-element-stub")).not.toBeInTheDocument();
  });

  it("never renders a raw card-number/CVC input", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({ error: { code: "stripe_unavailable", message: "n/a" } }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CheckoutForm trialDaysLeft={5} />);
    await screen.findByText("Order summary");

    expect(screen.queryByPlaceholderText("1234 1234 1234 1234")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("123")).not.toBeInTheDocument();
  });

  it("shows the already-subscribed state on a 409 already_active response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: "already_active", message: "Already subscribed." } }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CheckoutForm trialDaysLeft={0} />);

    expect(await screen.findByText(/already subscribed/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to account" })).toHaveAttribute("href", "/account");
  });
});
