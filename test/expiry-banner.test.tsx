import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  daysUntil,
  expiryDaysToShow,
  expiryMessage,
  expiryEndsAt,
  ExpiryBanner,
  DISMISS_KEY,
  EXPIRY_WINDOW_DAYS,
} from "@/app/(member)/expiry-banner";
import type { AccessRow } from "@/lib/api/access";

const DAY_MS = 24 * 60 * 60 * 1000;

function row(overrides: Partial<AccessRow>): AccessRow {
  return { status: null, trial_ends_at: null, current_period_end: null, ...overrides };
}

/** An ISO date `days` days out (minus half a day) so Math.ceil lands exactly on `days`. */
function daysOut(days: number, now: number = Date.now()): string {
  return new Date(now + (days - 0.5) * DAY_MS).toISOString();
}

beforeEach(() => {
  window.sessionStorage.clear();
});

describe("daysUntil", () => {
  it("returns null for a null endsAt", () => {
    expect(daysUntil(null)).toBeNull();
  });

  it("returns null for an unparseable string", () => {
    expect(daysUntil("not-a-date")).toBeNull();
  });

  it("rounds a fractional remainder UP", () => {
    const now = Date.now();
    const endsAt = new Date(now + 6 * DAY_MS + 4 * 60 * 60 * 1000).toISOString();
    expect(daysUntil(endsAt, now)).toBe(7);
  });
});

describe("expiryDaysToShow", () => {
  it("shows at 7 (inclusive)", () => {
    expect(expiryDaysToShow(7)).toBe(7);
  });

  it("shows at 3", () => {
    expect(expiryDaysToShow(3)).toBe(3);
  });

  it("shows at 1", () => {
    expect(expiryDaysToShow(1)).toBe(1);
  });

  it("hides at 8", () => {
    expect(expiryDaysToShow(8)).toBeNull();
  });

  it("hides at 0", () => {
    expect(expiryDaysToShow(0)).toBeNull();
  });

  it("hides at a negative count", () => {
    expect(expiryDaysToShow(-1)).toBeNull();
  });

  it("hides for null", () => {
    expect(expiryDaysToShow(null)).toBeNull();
  });
});

describe("expiryMessage", () => {
  it("is singular at 1 day", () => {
    expect(expiryMessage(1)).toBe("Your access ends in 1 day.");
  });

  it("is plural at 3 days", () => {
    expect(expiryMessage(3)).toBe("Your access ends in 3 days.");
  });
});

describe("expiryEndsAt", () => {
  it("returns trial_ends_at for a trial row", () => {
    const now = Date.now();
    const trialEndsAt = daysOut(5, now);
    expect(expiryEndsAt(row({ status: "trial", trial_ends_at: trialEndsAt }), now)).toBe(trialEndsAt);
  });

  it("returns current_period_end for an active row", () => {
    const now = Date.now();
    const currentPeriodEnd = daysOut(5, now);
    expect(expiryEndsAt(row({ status: "active", current_period_end: currentPeriodEnd }), now)).toBe(
      currentPeriodEnd,
    );
  });

  it("returns null for an active row with a null current_period_end", () => {
    expect(expiryEndsAt(row({ status: "active", current_period_end: null }))).toBeNull();
  });

  it("returns null for status lapsed", () => {
    expect(expiryEndsAt(row({ status: "lapsed", trial_ends_at: daysOut(5) }))).toBeNull();
  });

  it("returns null for status canceled", () => {
    expect(expiryEndsAt(row({ status: "canceled", current_period_end: daysOut(5) }))).toBeNull();
  });

  it("returns null for an EXPIRED trial", () => {
    const now = Date.now();
    const pastTrialEnd = new Date(now - DAY_MS).toISOString();
    expect(expiryEndsAt(row({ status: "trial", trial_ends_at: pastTrialEnd }), now)).toBeNull();
  });

  it("returns null for a null row", () => {
    expect(expiryEndsAt(null)).toBeNull();
  });
});

describe("<ExpiryBanner>", () => {
  it("renders for a trial at 5 days with a Renew now link to /checkout", async () => {
    const now = Date.now();
    const sub = row({ status: "trial", trial_ends_at: daysOut(5, now) });
    render(<ExpiryBanner subscription={sub} />);

    expect(await screen.findByText("Your access ends in 5 days.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Renew now" });
    expect(link).toHaveAttribute("href", "/checkout");
  });

  it("renders for an ACTIVE member with current_period_end 3 days out", async () => {
    const now = Date.now();
    const sub = row({ status: "active", current_period_end: daysOut(3, now) });
    render(<ExpiryBanner subscription={sub} />);

    expect(await screen.findByText("Your access ends in 3 days.")).toBeInTheDocument();
  });

  it("renders nothing for a trial at 8 days", async () => {
    const now = Date.now();
    const sub = row({ status: "trial", trial_ends_at: daysOut(8, now) });
    render(<ExpiryBanner subscription={sub} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("expiry-banner")).toBeNull();
  });

  // `daysOut(0)` is half a day in the PAST, which is the honest name for this
  // case: an exactly-zero day count is unreachable through the component,
  // because `hasAccess()` requires a strictly-future end date, so a member at
  // 0 has already lost entitlement. This is the "no zero state" rule — the
  // member is on the 402 path and the banner must stay down rather than nag
  // them to renew something they have already lost.
  it("renders nothing once the trial end has passed (the no-zero-state rule)", async () => {
    const now = Date.now();
    const sub = row({ status: "trial", trial_ends_at: daysOut(0, now) });
    render(<ExpiryBanner subscription={sub} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("expiry-banner")).toBeNull();
  });

  it("renders nothing for an active row with a null current_period_end", async () => {
    const sub = row({ status: "active", current_period_end: null });
    render(<ExpiryBanner subscription={sub} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("expiry-banner")).toBeNull();
  });

  it("renders nothing for status lapsed", async () => {
    const sub = row({ status: "lapsed", trial_ends_at: daysOut(5) });
    render(<ExpiryBanner subscription={sub} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("expiry-banner")).toBeNull();
  });

  it("renders nothing for status canceled", async () => {
    const sub = row({ status: "canceled", current_period_end: daysOut(5) });
    render(<ExpiryBanner subscription={sub} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("expiry-banner")).toBeNull();
  });

  it("renders nothing for a null subscription", async () => {
    render(<ExpiryBanner subscription={null} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("expiry-banner")).toBeNull();
  });

  it("dismiss hides the banner and stores the endsAt ISO string in sessionStorage", async () => {
    const now = Date.now();
    const endsAt = daysOut(5, now);
    const sub = row({ status: "trial", trial_ends_at: endsAt });
    const user = userEvent.setup();
    render(<ExpiryBanner subscription={sub} />);

    await screen.findByText("Your access ends in 5 days.");
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByTestId("expiry-banner")).toBeNull();
    expect(window.sessionStorage.getItem(DISMISS_KEY)).toBe(endsAt);
  });

  it("re-arms when sessionStorage holds a DIFFERENT dismissed date than the current endsAt", async () => {
    const now = Date.now();
    const endsAt = daysOut(5, now);
    window.sessionStorage.setItem(DISMISS_KEY, "2020-01-01T00:00:00.000Z");
    const sub = row({ status: "trial", trial_ends_at: endsAt });
    render(<ExpiryBanner subscription={sub} />);

    expect(await screen.findByText("Your access ends in 5 days.")).toBeInTheDocument();
  });

  it("stays hidden when sessionStorage holds the CURRENT endsAt", async () => {
    const now = Date.now();
    const endsAt = daysOut(5, now);
    window.sessionStorage.setItem(DISMISS_KEY, endsAt);
    const sub = row({ status: "trial", trial_ends_at: endsAt });
    render(<ExpiryBanner subscription={sub} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("expiry-banner")).toBeNull();
  });
});

describe("EXPIRY_WINDOW_DAYS", () => {
  // Asserting the constant equals 7 would just be the constant asserting
  // itself. What is worth pinning is that the exported window is the bound the
  // component actually applies — inclusive on the last day inside it, and shut
  // one day out — so that changing the constant moves the real behaviour.
  it("is the inclusive upper bound the banner applies", () => {
    expect(expiryDaysToShow(EXPIRY_WINDOW_DAYS)).toBe(EXPIRY_WINDOW_DAYS);
    expect(expiryDaysToShow(EXPIRY_WINDOW_DAYS + 1)).toBeNull();
  });
});
