import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ENG-585 — the Account screen must derive its status from ENTITLEMENT, not
// from the raw `subscription.status` string.
//
// The bug this file exists to prevent: `statusPill` returned "Active" for
// `status === "active"` without ever looking at `current_period_end`, so the
// DRI's member — expired an hour earlier, and correctly locked out by the
// server — opened the one screen that explains their account and was told
// "Status: Active", "30-day pass — Access to 16 August 2026" and "Your access
// runs to 16 August 2026", next to an "Extend access" button.
//
// ⚠️ THE `active` + `current_period_end: null` ROW IS ENTITLED. That is a member
// who has just paid and whose Stripe webhook has not landed yet. ENG-566,
// ENG-577 and ENG-582 each had to get this same null right one layer down;
// rendering it as expired would lock the screen against a paying member.

const DAY = 24 * 60 * 60 * 1000;
const future = new Date(Date.now() + 10 * DAY).toISOString();
const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();

type Sub = { status: string; trial_ends_at: string | null; current_period_end: string | null } | null;

const { fromMock, setSub } = vi.hoisted(() => {
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

import AccountPage from "@/app/(member)/account/page";

async function renderAccount(sub: Sub) {
  setSub(sub);
  render(await AccountPage());
}

/** The Status row's value — the pill this ticket is about. */
function statusValue(): string {
  const label = screen.getByText("Status");
  const value = label.parentElement?.querySelector(".value");
  return value?.textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Account status — the entitlement matrix", () => {
  it("active + FUTURE period end → Active (unchanged)", async () => {
    await renderAccount({ status: "active", trial_ends_at: null, current_period_end: future });
    expect(statusValue()).toBe("Active");
    expect(screen.getByText(/^Access to /)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Extend access" })).toBeInTheDocument();
  });

  // THE REGRESSION. This case fails against the pre-ENG-585 code, which
  // returned "Active" here.
  it("active + PAST period end → NOT Active, and no past date sold as current access", async () => {
    await renderAccount({ status: "active", trial_ends_at: null, current_period_end: past });

    expect(statusValue()).toBe("Ended");
    expect(statusValue()).not.toBe("Active");

    // The card must agree with the pill.
    expect(screen.getByText("No active pass")).toBeInTheDocument();
    expect(screen.queryByText(/^Access to /)).not.toBeInTheDocument();
    expect(screen.queryByText(/Your access runs to/)).not.toBeInTheDocument();
    // "Extend access" implies there is access to extend. There isn't.
    expect(screen.queryByRole("link", { name: "Extend access" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy 30 days" })).toBeInTheDocument();
  });

  // THE TRAP — ENG-566 / ENG-577 / ENG-582 all had to get this right.
  it("active + NULL period end → still entitled (webhook in flight), never expired", async () => {
    await renderAccount({ status: "active", trial_ends_at: null, current_period_end: null });
    expect(statusValue()).toBe("Active");
    expect(screen.getByText("30-day pass")).toBeInTheDocument();
    expect(screen.getByText("Access active")).toBeInTheDocument();
    expect(screen.queryByText(/Ended/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Extend access" })).toBeInTheDocument();
  });

  it("trial + FUTURE end → Trial · N days left (unchanged)", async () => {
    await renderAccount({ status: "trial", trial_ends_at: future, current_period_end: null });
    expect(statusValue()).toMatch(/^Trial · \d+ days left$/);
    expect(screen.getByText("Trial — full access")).toBeInTheDocument();
  });

  it("trial + PAST end → reads as ended, with no 'days left' and no negative count", async () => {
    await renderAccount({ status: "trial", trial_ends_at: past, current_period_end: null });
    expect(statusValue()).toBe("Trial ended");
    expect(statusValue()).not.toMatch(/days left/);
    expect(statusValue()).not.toMatch(/-\d/);
    expect(screen.getByText("No active pass")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Buy 30 days" })).toBeInTheDocument();
  });

  it("lapsed → Ended", async () => {
    await renderAccount({ status: "lapsed", trial_ends_at: null, current_period_end: past });
    expect(statusValue()).toBe("Ended");
    expect(screen.queryByText(/^Access to /)).not.toBeInTheDocument();
  });

  it("canceled → Ended", async () => {
    await renderAccount({ status: "canceled", trial_ends_at: null, current_period_end: past });
    expect(statusValue()).toBe("Ended");
  });

  // Not entitled does NOT mean the date has passed: `hasAccess()` denies
  // `canceled`/`lapsed` on the status alone, and those rows can legitimately
  // carry a FUTURE `current_period_end`. The card must not narrate a date that
  // has not happened yet in the past tense.
  it("canceled + FUTURE period end → never says 'Ended <a future date>'", async () => {
    await renderAccount({ status: "canceled", trial_ends_at: null, current_period_end: future });
    expect(statusValue()).toBe("Ended");
    expect(screen.getByText("Access ended")).toBeInTheDocument();
    expect(screen.queryByText(/^Ended \d/)).not.toBeInTheDocument();
    // …and still never sells the future date as current access.
    expect(screen.queryByText(/^Access to /)).not.toBeInTheDocument();
  });

  it("no subscription row at all → Ended, fails closed", async () => {
    await renderAccount(null);
    expect(statusValue()).toBe("Ended");
    expect(screen.getByText("No active pass")).toBeInTheDocument();
  });
});

describe("Account card copy", () => {
  it("never implies the pass renews", async () => {
    await renderAccount({ status: "active", trial_ends_at: null, current_period_end: future });
    expect(document.body.textContent).toMatch(/It does not renew/);
    expect(document.body.textContent).not.toMatch(/auto-?renew/i);
  });

  it("offers no cancel or payment-method affordance in any state", async () => {
    for (const sub of [
      { status: "active", trial_ends_at: null, current_period_end: future },
      { status: "active", trial_ends_at: null, current_period_end: past },
      { status: "trial", trial_ends_at: future, current_period_end: null },
    ]) {
      document.body.innerHTML = "";
      await renderAccount(sub);
      expect(document.body.textContent).not.toMatch(/cancel/i);
      expect(document.body.textContent).not.toMatch(/payment method/i);
      expect(document.body.textContent).not.toMatch(/reactivate/i);
    }
  });
});
