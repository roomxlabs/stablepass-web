import { describe, it, expect } from "vitest";
import {
  ACCOUNT_SUB_COLUMNS,
  addCalendarMonthsSydney,
  formatMoney,
  isComplimentary,
  isFailedRenewal,
  isStoreManaged,
  nextChargeAmount,
  providerLabel,
  remainingIntroMonths,
  storeManageCopy,
} from "@/app/(member)/account/billing";

describe("remainingIntroMonths", () => {
  it("0 used → 6 remaining", () => {
    expect(remainingIntroMonths(0)).toBe(6);
  });
  it("2 used → 4 remaining", () => {
    expect(remainingIntroMonths(2)).toBe(4);
  });
  it("6 used → 0 remaining", () => {
    expect(remainingIntroMonths(6)).toBe(0);
  });
  it("9 used → 0, never negative", () => {
    expect(remainingIntroMonths(9)).toBe(0);
  });
  it("null / non-finite fails TOWARD the discount", () => {
    expect(remainingIntroMonths(null)).toBe(6);
    expect(remainingIntroMonths(undefined)).toBe(6);
    expect(remainingIntroMonths(Number.NaN)).toBe(6);
  });
});

describe("nextChargeAmount", () => {
  const pricing = { unitAmount: 1900, discountAmount: 1000, currency: "aud" };
  it("applies the coupon while intro months remain", () => {
    expect(nextChargeAmount(pricing, 4)).toBe(900);
  });
  it("is the full price once intro is exhausted", () => {
    expect(nextChargeAmount(pricing, 0)).toBe(1900);
  });
});

describe("formatMoney", () => {
  it("formats AUD as A$ with en-US (never a bare $)", () => {
    expect(formatMoney(900, "aud")).toBe("A$9.00");
    expect(formatMoney(1900, "aud")).toBe("A$19.00");
  });
  it("derives from the amount, so a sandbox A$1.00 is honest", () => {
    expect(formatMoney(100, "aud")).toBe("A$1.00");
  });
});

describe("addCalendarMonthsSydney", () => {
  it("adds months on the Sydney civil date", () => {
    // 6 Oct 2026 00:00 in Sydney (AEST, UTC+10) = 2026-10-05T14:00:00.000Z
    expect(addCalendarMonthsSydney("2026-10-05T14:00:00.000Z", 6)).toBe("6 April 2027");
  });
  it("clamps a 31st into a shorter month rather than inventing a day", () => {
    // 31 Jan 2026 12:00 Sydney (AEDT, UTC+11) = 2026-01-31T01:00:00.000Z
    expect(addCalendarMonthsSydney("2026-01-31T01:00:00.000Z", 1)).toBe("28 February 2026");
  });
  it("returns null for an unparseable timestamp", () => {
    expect(addCalendarMonthsSydney("not-a-date", 1)).toBeNull();
  });
  it("returns null for a non-integer month count", () => {
    expect(addCalendarMonthsSydney("2026-10-05T14:00:00.000Z", 1.5)).toBeNull();
  });
});

describe("isFailedRenewal", () => {
  const base = {
    status: "lapsed",
    trial_ends_at: null,
    current_period_end: "2026-01-01T00:00:00Z",
    intro_months_used: 2,
    stripe_customer_id: "cus_1",
    canceled_at: null,
    provider: "stripe" as string | null,
  };
  it("lapsed + customer + no canceled_at → failed renewal", () => {
    expect(isFailedRenewal(base)).toBe(true);
  });
  it("a pre-migration null provider is treated as Stripe → still a failed renewal", () => {
    expect(isFailedRenewal({ ...base, provider: null })).toBe(true);
  });
  it.each(["app_store", "play_store", "promotional"])(
    "ENG-1192 — a %s row is never a failed card, even with a leftover Stripe customer",
    (provider) => {
      expect(isFailedRenewal({ ...base, provider })).toBe(false);
    },
  );
  it("lapsed without a customer is the never-subscribed funnel, not a failed card", () => {
    expect(isFailedRenewal({ ...base, stripe_customer_id: null })).toBe(false);
  });
  it("a cancelled member who later lapsed is not a failed renewal", () => {
    expect(isFailedRenewal({ ...base, canceled_at: "2026-01-01T00:00:00Z" })).toBe(false);
  });
  it("active is not a failed renewal", () => {
    expect(isFailedRenewal({ ...base, status: "active" })).toBe(false);
  });
  it("null row is not", () => {
    expect(isFailedRenewal(null)).toBe(false);
  });
});

describe("ACCOUNT_SUB_COLUMNS", () => {
  it("pins the exact projection the page selects (42703 / silent-drop)", () => {
    expect(ACCOUNT_SUB_COLUMNS).toBe(
      "status,trial_ends_at,current_period_end,intro_months_used,stripe_customer_id,canceled_at,provider",
    );
  });
});

describe("provider helpers (ENG-1192)", () => {
  it("isStoreManaged is true for app_store and play_store only", () => {
    expect(isStoreManaged({ provider: "app_store" })).toBe(true);
    expect(isStoreManaged({ provider: "play_store" })).toBe(true);
    expect(isStoreManaged({ provider: "stripe" })).toBe(false);
    expect(isStoreManaged({ provider: "promotional" })).toBe(false);
    expect(isStoreManaged({ provider: null })).toBe(false);
    expect(isStoreManaged(null)).toBe(false);
  });

  it("isComplimentary is true for promotional only", () => {
    expect(isComplimentary({ provider: "promotional" })).toBe(true);
    expect(isComplimentary({ provider: "app_store" })).toBe(false);
    expect(isComplimentary({ provider: "stripe" })).toBe(false);
    expect(isComplimentary({ provider: null })).toBe(false);
    expect(isComplimentary(null)).toBe(false);
  });

  it("providerLabel names the biller; stripe and null read as Web", () => {
    expect(providerLabel("app_store")).toBe("App Store");
    expect(providerLabel("play_store")).toBe("Google Play");
    expect(providerLabel("promotional")).toBe("Complimentary");
    expect(providerLabel("stripe")).toBe("Web");
    expect(providerLabel(null)).toBe("Web");
  });

  it("storeManageCopy points at the right store", () => {
    expect(storeManageCopy("app_store")).toBe(
      "To change your payment method or cancel, open Subscriptions in your iPhone Settings.",
    );
    expect(storeManageCopy("play_store")).toBe(
      "To change your payment method or cancel, open Subscriptions in the Google Play app.",
    );
  });
});
