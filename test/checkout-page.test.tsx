import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// CheckoutPage now reads `subscription.status` so an already-active member is
// redirected to /account (early renewal is gone). Price / coupon are still NOT
// read here — only status.

const { getUserMock, fromMock, selectMock, redirectMock } = vi.hoisted(() => {
  const getUserMock = vi.fn<() => Promise<{ data: { user: { id: string } | null } }>>(
    async () => ({ data: { user: { id: "user-1" } } }),
  );
  const selectMock = vi.fn();
  const redirectMock = vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  });

  function makeChain() {
    const chain = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn(async () => ({ data: { status: "lapsed" } })),
    };
    chain.select.mockImplementation((projection: unknown) => {
      selectMock(projection);
      return chain;
    });
    chain.eq.mockImplementation(() => chain);
    return chain;
  }

  const fromMock = vi.fn(() => makeChain());
  return { getUserMock, fromMock, selectMock, redirectMock };
});

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: getUserMock },
    from: fromMock,
  })),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn(async () => null),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PaymentElement: () => null,
  useStripe: () => null,
  useElements: () => null,
}));

import CheckoutPage from "@/app/(member)/checkout/page";
import { CheckoutForm } from "@/app/(member)/checkout/checkout-form";

describe("CheckoutPage — active member redirect (ENG-1027)", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    getUserMock.mockResolvedValue({ data: { user: { id: "user-1" } } });
    fromMock.mockReset();
    fromMock.mockImplementation(() => {
      const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(async () => ({ data: { status: "lapsed" } })),
      };
      chain.select.mockImplementation((projection: unknown) => {
        selectMock(projection);
        return chain;
      });
      chain.eq.mockImplementation(() => chain);
      return chain;
    });
    selectMock.mockClear();
    redirectMock.mockClear();
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch;
  });

  it("redirects an active member to /account", async () => {
    fromMock.mockImplementation(() => {
      const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(async () => ({ data: { status: "active" } })),
      };
      chain.select.mockImplementation((projection: unknown) => {
        selectMock(projection);
        return chain;
      });
      chain.eq.mockImplementation(() => chain);
      return chain;
    });

    await expect(CheckoutPage()).rejects.toThrow("REDIRECT:/account");
    expect(redirectMock).toHaveBeenCalledWith("/account");
  });

  it("renders CheckoutForm for a lapsed member and does not redirect", async () => {
    const element = await CheckoutPage();
    expect(redirectMock).not.toHaveBeenCalled();
    expect(element.type).toBe(CheckoutForm);

    render(element);
    expect(await screen.findByText("Order summary")).toBeInTheDocument();
  });

  it("selects only status — the coupon counter is not a second source of truth here", async () => {
    await CheckoutPage();
    expect(selectMock).toHaveBeenCalledWith("status");
    expect(selectMock.mock.calls.some((c) => String(c[0]).includes("intro_months_used"))).toBe(false);
  });

  it("passes no trialDaysLeft — the free trial is retired (ENG-999)", async () => {
    const element = await CheckoutPage();
    expect(Object.keys(element.props)).not.toContain("trialDaysLeft");
  });
});
