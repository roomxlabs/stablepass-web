import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ENG-585 — the Account screen must derive its status from ENTITLEMENT, not
// from the raw `subscription.status` string.
//
// ENG-1028 rewrites the card for a renewing membership: next charge, intro
// change-over, manage-card, payment-failed. The entitlement ordering is
// unchanged — do not regress it into reading `status` first.

const DAY = 24 * 60 * 60 * 1000;
const future = new Date(Date.now() + 10 * DAY).toISOString();
// ENG-1029: `active` has a 3-day renewal grace, so a 1-hour-old period is
// still entitled. "Past" here means grace-exhausted (≥4 days) — the same
// denial fixture ENG-1025 uses on the SQL / edge copies.
const past = new Date(Date.now() - 4 * DAY).toISOString();

type Sub = {
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  intro_months_used?: number | null;
  stripe_customer_id?: string | null;
  canceled_at?: string | null;
} | null;

const { fromMock, setSub, pricesRetrieve, couponsRetrieve } = vi.hoisted(() => {
  let sub: unknown = null;

  const appUserChain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({
      data: {
        first_name: "Justin",
        last_name: "Alpar",
        email: "you@stablepass.co",
        phone: "+61 431 581 526",
        pref_new_post: true,
        pref_race_day: true,
        pref_race_result: false,
        pref_milestone: false,
      },
    })),
  };
  appUserChain.select.mockImplementation(() => appUserChain);
  appUserChain.eq.mockImplementation(() => appUserChain);

  const subscriptionChain = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data: sub })),
  };
  subscriptionChain.select.mockImplementation(() => subscriptionChain);
  subscriptionChain.eq.mockImplementation(() => subscriptionChain);

  return {
    fromMock: vi.fn((table: string) => (table === "app_user" ? appUserChain : subscriptionChain)),
    setSub: (next: unknown) => {
      sub = next;
    },
    pricesRetrieve: vi.fn(),
    couponsRetrieve: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  usePathname: () => "/account",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })) },
    from: fromMock,
  })),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(() => ({
    prices: { retrieve: pricesRetrieve },
    coupons: { retrieve: couponsRetrieve },
  })),
}));

import AccountPage from "@/app/(member)/account/page";
import { readFileSync } from "node:fs";
import path from "node:path";

const ORIGINAL_ENV = process.env;

async function renderAccount(sub: Sub) {
  setSub(sub);
  render(await AccountPage());
}

function statusValue(): string {
  const label = screen.getByText("Status");
  const value = label.parentElement?.querySelector(".value");
  return value?.textContent ?? "";
}

function statusColour(): string {
  const label = screen.getByText("Status");
  const value = label.parentElement?.querySelector(".value") as HTMLElement | null;
  return value?.style.color ?? "";
}

function activeSub(overrides: Partial<Exclude<Sub, null>> = {}): Exclude<Sub, null> {
  return {
    status: "active",
    trial_ends_at: null,
    current_period_end: future,
    intro_months_used: 1,
    stripe_customer_id: "cus_1",
    canceled_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = {
    ...ORIGINAL_ENV,
    STRIPE_PRICE_ID_STANDARD: "price_standard",
    STRIPE_SECRET_KEY: "sk_test_dummy",
  };
  pricesRetrieve.mockResolvedValue({ unit_amount: 1900, currency: "aud" });
  couponsRetrieve.mockResolvedValue({ amount_off: 1000, currency: "aud" });
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("Account status — the entitlement matrix", () => {
  it("active + FUTURE period end → Active", async () => {
    await renderAccount(activeSub());
    expect(statusValue()).toBe("Active");
    expect(screen.getByText(/^Access until /)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage card" })).toBeInTheDocument();
  });

  it("active + PAST period end → Ended, and no past date sold as current access", async () => {
    await renderAccount(activeSub({ current_period_end: past }));

    expect(statusValue()).toBe("Ended");
    expect(statusValue()).not.toBe("Active");
    expect(screen.getByText("No active subscription")).toBeInTheDocument();
    expect(screen.queryByText(/^Access until /)).not.toBeInTheDocument();
    expect(screen.queryByTestId("next-charge")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Subscribe" })).toBeInTheDocument();
  });

  it("active + NULL period end → still entitled (webhook in flight), never expired", async () => {
    await renderAccount(activeSub({ current_period_end: null }));
    expect(statusValue()).toBe("Active");
    expect(screen.getByText("Monthly membership")).toBeInTheDocument();
    expect(screen.getByText("Access active")).toBeInTheDocument();
    expect(screen.queryByTestId("next-charge")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage card" })).toBeInTheDocument();
  });

  it("canceled + FUTURE period end → 'Access ending' (still entitled, not the red Ended colour)", async () => {
    await renderAccount(activeSub({ status: "canceled", canceled_at: "2026-09-01T00:00:00Z" }));

    expect(statusValue()).toBe("Access ending");
    expect(statusColour()).toBe("var(--brand-green)");
    expect(screen.getByText("Monthly membership")).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/continues until /);
    expect(document.body.textContent).toMatch(/won't be charged again/);
    expect(screen.queryByTestId("next-charge")).not.toBeInTheDocument();
  });

  it("canceled + PAST period end → Ended", async () => {
    await renderAccount(
      activeSub({
        status: "canceled",
        current_period_end: past,
        canceled_at: "2026-08-01T00:00:00Z",
      }),
    );
    expect(statusValue()).toBe("Ended");
    expect(screen.getByText("No active subscription")).toBeInTheDocument();
  });

  it("lapsed + past period end + no customer → Ended, generic copy, not payment-failed", async () => {
    await renderAccount(
      activeSub({
        status: "lapsed",
        current_period_end: past,
        stripe_customer_id: null,
      }),
    );
    expect(statusValue()).toBe("Ended");
    expect(screen.queryByTestId("payment-failed")).not.toBeInTheDocument();
    expect(document.body.textContent).toMatch(/access has ended/i);
    expect(screen.getByRole("link", { name: "Subscribe" })).toBeInTheDocument();
  });

  it("no subscription row at all → Ended, fails closed", async () => {
    await renderAccount(null);
    expect(statusValue()).toBe("Ended");
    expect(screen.getByText("No active subscription")).toBeInTheDocument();
  });
});

describe("Next charge + intro change-over", () => {
  it("active member inside intro sees next charge amount/date and the A$19 change-over", async () => {
    await renderAccount(activeSub({ intro_months_used: 1 }));

    const next = screen.getByTestId("next-charge");
    expect(next.textContent).toMatch(/A\$9\.00 on /);
    const change = screen.getByTestId("change-over");
    expect(change.textContent).toMatch(/A\$19\.00 per month/);
    expect(change.textContent).not.toMatch(/ from /);
    expect(pricesRetrieve).toHaveBeenCalledWith("price_standard");
    expect(couponsRetrieve).toHaveBeenCalledWith("intro_5");
  });

  it("active member past intro sees the standard next charge and no change-over line", async () => {
    await renderAccount(activeSub({ intro_months_used: 6 }));

    const next = screen.getByTestId("next-charge");
    expect(next.textContent).toMatch(/A\$19\.00 on /);
    expect(screen.queryByTestId("change-over")).not.toBeInTheDocument();
    expect(couponsRetrieve).not.toHaveBeenCalled();
  });

  it("omits amounts rather than inventing them when Stripe is unreadable", async () => {
    pricesRetrieve.mockRejectedValue(new Error("nope"));
    await renderAccount(activeSub());

    const next = screen.getByTestId("next-charge");
    expect(next.textContent).not.toMatch(/A\$/);
    expect(next.textContent).toMatch(/On /);
    // Label is already "Then" — the value must not repeat it.
    expect(screen.getByTestId("change-over").querySelector(".value")?.textContent).toBe(
      "the standard monthly price",
    );
  });

  it("webhook-in-flight (null period) with intro remaining falls back to 'then A$19.00 per month' without a date", async () => {
    await renderAccount(activeSub({ current_period_end: null, intro_months_used: 2 }));
    const change = screen.getByTestId("change-over");
    expect(change.textContent).toMatch(/A\$19\.00 per month/);
    expect(change.textContent).not.toMatch(/ from /);
  });
});

describe("Payment-failed state", () => {
  it("lapsed + stripe customer + no canceled_at → payment-failed copy and portal link, not 'access ended'", async () => {
    await renderAccount(
      activeSub({
        status: "lapsed",
        current_period_end: past,
        stripe_customer_id: "cus_failed",
        canceled_at: null,
      }),
    );

    expect(statusValue()).toBe("Ended");
    expect(screen.getByTestId("payment-failed")).toHaveTextContent(/payment didn't go through/i);
    expect(screen.getByTestId("payment-failed").textContent).not.toMatch(/access ended/i);
    expect(screen.getByRole("link", { name: "Update your card" })).toHaveAttribute(
      "href",
      "/api/subscription/portal",
    );
    expect(screen.getByRole("link", { name: "Subscribe" })).toHaveAttribute("href", "/checkout");
    expect(screen.queryByTestId("next-charge")).not.toBeInTheDocument();
  });
});

describe("Cancel control visibility", () => {
  it("present for active + FUTURE period end", async () => {
    await renderAccount(activeSub());
    expect(screen.getByTestId("cancel-open")).toBeInTheDocument();
  });

  it("absent for active + PAST period end (entitlement decides, not the raw status)", async () => {
    await renderAccount(activeSub({ current_period_end: past }));
    expect(screen.queryByTestId("cancel-open")).not.toBeInTheDocument();
  });

  it("absent for active + NULL period end (webhook in flight)", async () => {
    await renderAccount(activeSub({ current_period_end: null }));
    expect(screen.queryByTestId("cancel-open")).not.toBeInTheDocument();
    expect(statusValue()).toBe("Active");
  });

  it("absent for canceled + FUTURE period end", async () => {
    await renderAccount(activeSub({ status: "canceled" }));
    expect(screen.queryByTestId("cancel-open")).not.toBeInTheDocument();
  });

  it("absent for lapsed", async () => {
    await renderAccount(activeSub({ status: "lapsed", current_period_end: past }));
    expect(screen.queryByTestId("cancel-open")).not.toBeInTheDocument();
  });

  it("absent for a null subscription row", async () => {
    await renderAccount(null);
    expect(screen.queryByTestId("cancel-open")).not.toBeInTheDocument();
  });
});

describe("Retired buy-days copy is gone", () => {
  const retired = /Buy 30 days|Extend access|30-day pass|does not renew|doesn’t renew|buy another 30 days/i;

  it.each([
    ["active + future", activeSub()],
    ["active + null", activeSub({ current_period_end: null })],
    ["active + past", activeSub({ current_period_end: past })],
    ["canceled + future", activeSub({ status: "canceled" })],
    ["canceled + past", activeSub({ status: "canceled", current_period_end: past })],
    ["lapsed never-sub", activeSub({ status: "lapsed", current_period_end: past, stripe_customer_id: null })],
    ["payment-failed", activeSub({ status: "lapsed", current_period_end: past, stripe_customer_id: "cus_x" })],
    ["null row", null],
  ] as const)("%s", async (_label, sub) => {
    document.body.innerHTML = "";
    await renderAccount(sub as Sub);
    expect(document.body.textContent).not.toMatch(retired);
    expect(document.body.textContent).not.toMatch(/trial/i);
  });

  it("source of the card + cancel island does not contain the retired strings", () => {
    const files = [
      "app/(member)/account/page.tsx",
      "app/(member)/account/cancel-card.tsx",
      "app/(member)/account/billing.ts",
    ];
    for (const rel of files) {
      const src = readFileSync(path.join(process.cwd(), rel), "utf8");
      expect(src, rel).not.toMatch(/Buy 30 days|Extend access|30-day pass/);
      expect(src, rel).not.toMatch(/does not renew|buy another 30 days/i);
    }
  });
});
