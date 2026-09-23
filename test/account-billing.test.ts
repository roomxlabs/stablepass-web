import { describe, it, expect } from "vitest";
import {
  ACCOUNT_SUB_COLUMNS,
  formatMoney,
  isComplimentary,
  isFailedRenewal,
  isStoreManaged,
  isTrialling,
  providerLabel,
  storeManageCopy,
} from "@/app/(member)/account/billing";

describe("formatMoney", () => {
  it("formats AUD as A$ with en-US (never a bare $)", () => {
    expect(formatMoney(999, "aud")).toBe("A$9.99");
  });
  it("derives from the amount, so a sandbox A$1.00 is honest", () => {
    expect(formatMoney(100, "aud")).toBe("A$1.00");
  });
});

describe("isTrialling", () => {
  it("period_type 'trial' → true", () => {
    expect(isTrialling({ period_type: "trial" })).toBe(true);
  });
  it("period_type 'normal' → false", () => {
    expect(isTrialling({ period_type: "normal" })).toBe(false);
  });
  it("period_type null → false (reads as paid, never a trial)", () => {
    expect(isTrialling({ period_type: null })).toBe(false);
  });
  it("period_type undefined / missing row → false", () => {
    expect(isTrialling({ period_type: undefined })).toBe(false);
    expect(isTrialling(null)).toBe(false);
    expect(isTrialling(undefined)).toBe(false);
  });
});

describe("isFailedRenewal", () => {
  const base = {
    status: "lapsed",
    trial_ends_at: null,
    current_period_end: "2026-01-01T00:00:00Z",
    period_type: "normal",
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
      "status,trial_ends_at,current_period_end,period_type,stripe_customer_id,canceled_at,provider",
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
