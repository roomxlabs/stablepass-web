import { describe, it, expect } from "vitest";
import { hasAccess, type AccessRow } from "@/lib/api/access";

// ENG-999 rewrote the rule to `status in ('active','canceled') and
// (current_period_end is null or current_period_end > now())` and retired the
// free trial outright. `trial_ends_at` stays ON the row type (layout.tsx still
// reads it) but `hasAccess()` no longer consults it — a `trial` row is simply
// not entitled any more, mirrored by `has_content_access()` in
// stablepass-be/supabase/migrations/20260905120000_paid_only_subscription.sql.

const NOW = Date.parse("2026-08-15T12:00:00Z");

function row(status: string | null, trial_ends_at: string | null, current_period_end: string | null): AccessRow {
  return { status, trial_ends_at, current_period_end };
}

describe("hasAccess", () => {
  describe("active", () => {
    it("future current_period_end -> true", () => {
      expect(hasAccess(row("active", null, "2026-08-16T00:00:00Z"), NOW)).toBe(true);
    });

    it("null current_period_end -> true (regression guard: a paid member must not be locked out while the webhook is in flight)", () => {
      expect(hasAccess(row("active", null, null), NOW)).toBe(true);
    });

    it("past current_period_end -> false", () => {
      expect(hasAccess(row("active", null, "2026-08-14T00:00:00Z"), NOW)).toBe(false);
    });
  });

  // The new grant (ENG-999/ENG-1002): the pass is bought outright and
  // non-renewing, so cancelling is a statement about the NEXT pass, not a
  // refund of the one already paid for. A cancelled member keeps everything
  // they bought until `current_period_end`, exactly like an uncancelled one.
  describe("canceled", () => {
    it("future current_period_end -> true (a cancelled member keeps the days they paid for)", () => {
      expect(hasAccess(row("canceled", null, "2026-08-16T00:00:00Z"), NOW)).toBe(true);
    });

    it("null current_period_end -> true", () => {
      expect(hasAccess(row("canceled", null, null), NOW)).toBe(true);
    });

    it("past current_period_end -> false", () => {
      expect(hasAccess(row("canceled", null, "2026-08-14T00:00:00Z"), NOW)).toBe(false);
    });
  });

  // The trial branch is GONE. These are asserted explicitly — not deleted —
  // so a re-added trial arm in `hasAccess()` goes red immediately.
  describe("trial (retired by ENG-999)", () => {
    it("future trial_ends_at -> FALSE (the trial branch no longer exists)", () => {
      expect(hasAccess(row("trial", "2026-08-16T00:00:00Z", null), NOW)).toBe(false);
    });

    it("future current_period_end on a trial row -> FALSE too (status gates first)", () => {
      expect(hasAccess(row("trial", null, "2026-08-16T00:00:00Z"), NOW)).toBe(false);
    });
  });

  describe("lapsed", () => {
    it("-> false regardless of dates", () => {
      expect(hasAccess(row("lapsed", null, null), NOW)).toBe(false);
    });

    it("future current_period_end -> false (status alone denies it)", () => {
      expect(hasAccess(row("lapsed", null, "2026-08-16T00:00:00Z"), NOW)).toBe(false);
    });
  });

  it("null row -> false", () => {
    expect(hasAccess(null, NOW)).toBe(false);
  });

  it("status null -> false", () => {
    expect(hasAccess(row(null, null, null), NOW)).toBe(false);
  });

  it("unparseable current_period_end on an active row -> false (fails closed)", () => {
    expect(hasAccess(row("active", null, "not-a-date"), NOW)).toBe(false);
  });

  it("unparseable current_period_end on a canceled row -> false (fails closed)", () => {
    expect(hasAccess(row("canceled", null, "not-a-date"), NOW)).toBe(false);
  });

  // The lockout trap: a call site that forgets to widen its select leaves the
  // timestamp columns UNDEFINED (not null). Date.parse(undefined) is NaN, so
  // this must fail CLOSED — denying a real paying member rather than leaking.
  it("active row missing current_period_end entirely (un-widened select) -> false", () => {
    expect(hasAccess({ status: "active" } as unknown as AccessRow, NOW)).toBe(false);
  });

  it("canceled row missing current_period_end entirely (un-widened select) -> false", () => {
    expect(hasAccess({ status: "canceled" } as unknown as AccessRow, NOW)).toBe(false);
  });

  it("defaults `now` to Date.now() when not passed", () => {
    expect(
      hasAccess({
        status: "active",
        trial_ends_at: null,
        current_period_end: new Date(Date.now() + 60000).toISOString(),
      }),
    ).toBe(true);
  });

  // ── LOCKSTEP PIN ─────────────────────────────────────────────────────────
  // This table is the same six status/date combinations `has_content_access()`
  // answers in stablepass-be/supabase/migrations/20260905120000_paid_only_subscription.sql.
  // If either side is edited without the other, this test (or its DB-side
  // mirror) is the thing that should go red.
  it.each([
    ["active", "future", true],
    ["active", "past", false],
    ["active", "null", true],
    ["canceled", "future", true],
    ["canceled", "past", false],
    ["canceled", "null", true],
  ] as const)("%s + %s current_period_end -> %s", (status, when, expected) => {
    const cpe = when === "future" ? "2026-08-16T00:00:00Z" : when === "past" ? "2026-08-14T00:00:00Z" : null;
    expect(hasAccess(row(status, null, cpe), NOW)).toBe(expected);
  });
});
