// Pure unit tests, no mocks — app/api/notifications/contract.ts. ENG-957.
import { describe, it, expect } from "vitest";
import {
  notificationTarget,
  navigableTarget,
  targetHref,
  formatUnreadBadge,
  NOTIFICATION_SELECT,
} from "@/app/api/notifications/contract";

describe("notificationTarget / navigableTarget", () => {
  it("resolves a horse target_type + id to {screen:'horse', id}", () => {
    expect(notificationTarget({ targetType: "horse", targetId: "h1" })).toEqual({ screen: "horse", id: "h1" });
    expect(navigableTarget({ targetType: "horse", targetId: "h1" })).toEqual({ screen: "horse", id: "h1" });
  });

  // DELIBERATE: web has no post detail route (app/(member)/ has only
  // horses/[id] and trainers/[id]), so a post-targeted alert resolves to null
  // — it still lists and marks itself read, it just never navigates. Same for
  // race, which no platform can resolve without a horse hint. Both fail CLOSED
  // rather than guessing a route that does not exist.
  it("resolves target_type 'post' to null — DELIBERATE, no web post detail route", () => {
    expect(notificationTarget({ targetType: "post", targetId: "p1" })).toBeNull();
    expect(navigableTarget({ targetType: "post", targetId: "p1" })).toBeNull();
  });

  it("resolves target_type 'race' to null — DELIBERATE, fails closed like mobile", () => {
    expect(notificationTarget({ targetType: "race", targetId: "r1" })).toBeNull();
    expect(navigableTarget({ targetType: "race", targetId: "r1" })).toBeNull();
  });

  it("resolves an unknown/garbage target_type to null", () => {
    expect(notificationTarget({ targetType: "spaceship", targetId: "x1" })).toBeNull();
    expect(notificationTarget({ targetType: null, targetId: "x1" })).toBeNull();
    expect(notificationTarget({ targetType: undefined, targetId: "x1" })).toBeNull();
  });

  it("resolves a horse target with an empty or whitespace-only id to null", () => {
    expect(notificationTarget({ targetType: "horse", targetId: "" })).toBeNull();
    expect(notificationTarget({ targetType: "horse", targetId: "   " })).toBeNull();
    expect(notificationTarget({ targetType: "horse", targetId: null })).toBeNull();
    expect(notificationTarget({ targetType: "horse", targetId: undefined })).toBeNull();
  });
});

describe("targetHref", () => {
  it("builds the gated horse profile href", () => {
    expect(targetHref({ screen: "horse", id: "h1" })).toBe("/horses/h1");
  });
});

describe("formatUnreadBadge", () => {
  it("returns null for 0", () => {
    expect(formatUnreadBadge(0)).toBeNull();
  });

  it("returns null for a negative count", () => {
    expect(formatUnreadBadge(-1)).toBeNull();
  });

  it("returns null for NaN", () => {
    expect(formatUnreadBadge(NaN)).toBeNull();
  });

  it("returns the plain count under the cap", () => {
    expect(formatUnreadBadge(1)).toBe("1");
    expect(formatUnreadBadge(99)).toBe("99");
  });

  it("caps at 99+ for 100 and above", () => {
    expect(formatUnreadBadge(100)).toBe("99+");
    expect(formatUnreadBadge(5000)).toBe("99+");
  });
});

describe("NOTIFICATION_SELECT", () => {
  it("is an explicit allow-list — never '*', never user_id (guardrail #2, no owner PII)", () => {
    expect(NOTIFICATION_SELECT).not.toContain("*");
    expect(NOTIFICATION_SELECT.split(",")).not.toContain("user_id");
  });
});
