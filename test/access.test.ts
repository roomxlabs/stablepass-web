import { describe, it, expect } from "vitest";
import { hasAccess, type AccessRow } from "@/lib/api/access";

const NOW = Date.parse("2026-08-15T12:00:00Z");

function row(status: string | null, trial_ends_at: string | null, current_period_end: string | null): AccessRow {
  return { status, trial_ends_at, current_period_end };
}

describe("hasAccess", () => {
  it("active + current_period_end in the future -> true", () => {
    expect(hasAccess(row("active", null, "2026-08-16T00:00:00Z"), NOW)).toBe(true);
  });

  it("active + current_period_end null -> true (regression guard: a paid member must not be locked out while the webhook is in flight)", () => {
    expect(hasAccess(row("active", null, null), NOW)).toBe(true);
  });

  it("active + current_period_end in the past -> false", () => {
    expect(hasAccess(row("active", null, "2026-08-14T00:00:00Z"), NOW)).toBe(false);
  });

  it("trial + trial_ends_at in the future -> true", () => {
    expect(hasAccess(row("trial", "2026-08-16T00:00:00Z", null), NOW)).toBe(true);
  });

  it("trial + trial_ends_at in the past -> false", () => {
    expect(hasAccess(row("trial", "2026-08-14T00:00:00Z", null), NOW)).toBe(false);
  });

  it("trial + trial_ends_at null -> false", () => {
    expect(hasAccess(row("trial", null, null), NOW)).toBe(false);
  });

  it('status "lapsed" -> false', () => {
    expect(hasAccess(row("lapsed", null, null), NOW)).toBe(false);
  });

  it('status "canceled" -> false', () => {
    expect(hasAccess(row("canceled", null, null), NOW)).toBe(false);
  });

  it("null row -> false", () => {
    expect(hasAccess(null, NOW)).toBe(false);
  });

  it("unparseable current_period_end on an active row -> false (fails closed)", () => {
    expect(hasAccess(row("active", null, "not-a-date"), NOW)).toBe(false);
  });

  it("unparseable trial_ends_at on a trial row -> false (fails closed)", () => {
    expect(hasAccess(row("trial", "not-a-date", null), NOW)).toBe(false);
  });

  it("status null -> false", () => {
    expect(hasAccess(row(null, null, null), NOW)).toBe(false);
  });

  // The lockout trap: a call site that forgets to widen its select leaves the
  // timestamp columns UNDEFINED (not null). Date.parse(undefined) is NaN, so
  // this must fail CLOSED — denying a real paying member rather than leaking.
  it("active row missing current_period_end entirely (un-widened select) -> false", () => {
    expect(hasAccess({ status: "active" } as unknown as AccessRow, NOW)).toBe(false);
  });

  it("trial row missing trial_ends_at entirely (un-widened select) -> false", () => {
    expect(hasAccess({ status: "trial" } as unknown as AccessRow, NOW)).toBe(false);
  });

  it("defaults `now` to Date.now() when not passed", () => {
    expect(
      hasAccess({ status: "trial", trial_ends_at: new Date(Date.now() + 60000).toISOString(), current_period_end: null }),
    ).toBe(true);
  });
});
