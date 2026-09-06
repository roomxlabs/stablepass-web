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
//
// ENG-999 retired the free trial (there is no trial wording anywhere on this
// screen any more) and ENG-1002 made `canceled` an ENTITLED status: a
// cancelled member keeps the days they already paid for, so this file's
// matrix now covers `canceled` alongside `active`/`lapsed` rather than a
// third `trial` state.

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

/** The inline colour React wrote onto the pill — asserted as a literal string. */
function statusColour(): string {
  const label = screen.getByText("Status");
  const value = label.parentElement?.querySelector(".value") as HTMLElement | null;
  return value?.style.color ?? "";
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
  it("active + PAST period end → Ended, and no past date sold as current access", async () => {
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

  // ENG-1002: `canceled` is now an ENTITLED status while inside its paid
  // period. The pill must say so WITHOUT reading as "everything is fine" —
  // hence a distinct label, still in the entitled (green) colour.
  it("canceled + FUTURE period end → 'Access ending' (still entitled, not the red Ended colour)", async () => {
    await renderAccount({ status: "canceled", trial_ends_at: null, current_period_end: future });

    expect(statusValue()).toBe("Access ending");
    expect(statusColour()).not.toBe("var(--red)");
    expect(screen.getByText("30-day pass")).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/continues to /);
    expect(document.body.textContent).toMatch(/will not continue/);
  });

  it("canceled + PAST period end → Ended", async () => {
    await renderAccount({ status: "canceled", trial_ends_at: null, current_period_end: past });
    expect(statusValue()).toBe("Ended");
    expect(screen.getByText("No active pass")).toBeInTheDocument();
  });

  it("lapsed + past period end → Ended", async () => {
    await renderAccount({ status: "lapsed", trial_ends_at: null, current_period_end: past });
    expect(statusValue()).toBe("Ended");
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

  it("offers no payment-method or reactivate affordance in any state", async () => {
    for (const sub of [
      { status: "active", trial_ends_at: null, current_period_end: future },
      { status: "active", trial_ends_at: null, current_period_end: past },
      { status: "canceled", trial_ends_at: null, current_period_end: future },
    ]) {
      document.body.innerHTML = "";
      await renderAccount(sub);
      expect(document.body.textContent).not.toMatch(/payment method/i);
      expect(document.body.textContent).not.toMatch(/reactivate/i);
    }
  });
});

// ENG-1002: only a member with an active row and remaining entitlement is
// offered the Cancel control. A lapsed member has nothing to cancel (the RPC
// would just answer 409), and an already-cancelled member must not be shown
// it again.
describe("Cancel control visibility", () => {
  it("present for active + FUTURE period end", async () => {
    await renderAccount({ status: "active", trial_ends_at: null, current_period_end: future });
    expect(screen.getByTestId("cancel-open")).toBeInTheDocument();
  });

  it("present for active + NULL period end (webhook in flight, still entitled)", async () => {
    await renderAccount({ status: "active", trial_ends_at: null, current_period_end: null });
    expect(screen.getByTestId("cancel-open")).toBeInTheDocument();
  });

  it("absent for canceled + FUTURE period end", async () => {
    await renderAccount({ status: "canceled", trial_ends_at: null, current_period_end: future });
    expect(screen.queryByTestId("cancel-open")).not.toBeInTheDocument();
  });

  it("absent for canceled + PAST period end", async () => {
    await renderAccount({ status: "canceled", trial_ends_at: null, current_period_end: past });
    expect(screen.queryByTestId("cancel-open")).not.toBeInTheDocument();
  });

  it("absent for lapsed", async () => {
    await renderAccount({ status: "lapsed", trial_ends_at: null, current_period_end: past });
    expect(screen.queryByTestId("cancel-open")).not.toBeInTheDocument();
  });

  it("absent for a null subscription row", async () => {
    await renderAccount(null);
    expect(screen.queryByTestId("cancel-open")).not.toBeInTheDocument();
  });
});

// ENG-999 retired the free trial outright — the branches were removed, not
// left unreachable — so no state of this screen should print the word
// "trial" anywhere any more.
describe("No trial wording anywhere on this screen", () => {
  it.each([
    ["active + future", { status: "active", trial_ends_at: null, current_period_end: future }],
    ["active + null", { status: "active", trial_ends_at: null, current_period_end: null }],
    ["active + past", { status: "active", trial_ends_at: null, current_period_end: past }],
    ["canceled + future", { status: "canceled", trial_ends_at: null, current_period_end: future }],
    ["canceled + past", { status: "canceled", trial_ends_at: null, current_period_end: past }],
    ["lapsed", { status: "lapsed", trial_ends_at: null, current_period_end: past }],
    ["null row", null],
  ] as const)("%s", async (_label, sub) => {
    document.body.innerHTML = "";
    await renderAccount(sub as Sub);
    expect(document.body.textContent).not.toMatch(/trial/i);
  });
});
