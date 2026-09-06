import { describe, it, expect } from "vitest";
import { hasAccess, type AccessRow } from "@/lib/api/access";

// ENG-1029 mirrors ENG-1025's gate in this repo (the third copy). The clock
// and the case names below are aligned with
// stablepass-be/test/shared/access.test.mjs Part 1 + the SQL agreement rows
// so a future drift is visible by diffing the two files.
//
//   (status = 'active'
//      and (current_period_end is null
//           or current_period_end + interval '3 days' > now()))
//   or (status = 'canceled' and current_period_end > now())
//
// `trial_ends_at` stays ON the row type (layout.tsx still reads it) but
// `hasAccess()` no longer consults it — a `trial` row is simply not entitled.

const NOW_ISO = "2026-08-16T00:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function row(status: string | null, trial_ends_at: string | null, current_period_end: string | null): AccessRow {
  return { status, trial_ends_at, current_period_end };
}

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe("hasAccess", () => {
  describe("active + current_period_end", () => {
    it("1h in the past -> true (within 3-day renewal grace)", () => {
      expect(hasAccess(row("active", null, iso(-HOUR)), NOW)).toBe(true);
    });

    it("exactly AT now -> true (within 3-day renewal grace)", () => {
      expect(hasAccess(row("active", null, NOW_ISO), NOW)).toBe(true);
    });

    it("1ms in the future -> true", () => {
      expect(hasAccess(row("active", null, iso(1)), NOW)).toBe(true);
    });

    it("1 day in the past -> true (within 3-day renewal grace)", () => {
      expect(hasAccess(row("active", null, iso(-DAY)), NOW)).toBe(true);
    });

    it("exactly 3 days in the past -> false (grace boundary, strict >)", () => {
      expect(hasAccess(row("active", null, iso(-3 * DAY)), NOW)).toBe(false);
    });

    it("3 days − 1ms in the past -> true (still inside grace)", () => {
      expect(hasAccess(row("active", null, iso(-3 * DAY + 1)), NOW)).toBe(true);
    });

    it("4 days in the past -> false (grace exhausted)", () => {
      expect(hasAccess(row("active", null, iso(-4 * DAY)), NOW)).toBe(false);
    });

    it("null -> true (webhook-in-flight grant — must never regress)", () => {
      expect(hasAccess(row("active", null, null), NOW)).toBe(true);
    });

    it("absent key -> false (partial row fails closed; NOT the same as null)", () => {
      expect(hasAccess({ status: "active" } as unknown as AccessRow, NOW)).toBe(false);
    });

    it("unparseable garbage -> false (fail closed)", () => {
      expect(hasAccess(row("active", null, "not-a-timestamp"), NOW)).toBe(false);
      expect(hasAccess(row("active", null, ""), NOW)).toBe(false);
      expect(hasAccess(row("active", null, "not-a-date"), NOW)).toBe(false);
    });
  });

  describe("canceled + current_period_end", () => {
    it("1h in the past -> false (no grace)", () => {
      expect(hasAccess(row("canceled", null, iso(-HOUR)), NOW)).toBe(false);
    });

    it("exactly AT now -> false (strictly-after boundary)", () => {
      expect(hasAccess(row("canceled", null, NOW_ISO), NOW)).toBe(false);
    });

    it("future -> true (cancel-at-period-end: the member keeps the days they paid for)", () => {
      expect(hasAccess(row("canceled", null, iso(HOUR)), NOW)).toBe(true);
    });

    it("tomorrow -> true", () => {
      expect(hasAccess(row("canceled", null, iso(DAY)), NOW)).toBe(true);
    });

    it("null -> false (canceled is strict; null does not grant)", () => {
      expect(hasAccess(row("canceled", null, null), NOW)).toBe(false);
    });

    it("absent key -> false (partial row fails closed)", () => {
      expect(hasAccess({ status: "canceled" } as unknown as AccessRow, NOW)).toBe(false);
    });

    it("unparseable garbage -> false (fail closed)", () => {
      expect(hasAccess(row("canceled", null, "not-a-date"), NOW)).toBe(false);
    });
  });

  // The trial branch is GONE. These are asserted explicitly — not deleted —
  // so a re-added trial arm in `hasAccess()` goes red immediately.
  describe("trial (retired by ENG-999)", () => {
    it("future trial_ends_at -> FALSE (the trial branch no longer exists)", () => {
      expect(hasAccess(row("trial", "2026-08-17T00:00:00Z", null), NOW)).toBe(false);
    });

    it("future current_period_end on a trial row -> FALSE too (status gates first)", () => {
      expect(hasAccess(row("trial", null, iso(HOUR)), NOW)).toBe(false);
    });
  });

  describe("lapsed", () => {
    it("-> false regardless of dates", () => {
      expect(hasAccess(row("lapsed", null, null), NOW)).toBe(false);
    });

    it("future current_period_end -> false (status alone denies it)", () => {
      expect(hasAccess(row("lapsed", null, iso(HOUR)), NOW)).toBe(false);
    });
  });

  describe("other statuses -> false regardless of a future current_period_end", () => {
    it.each([
      ["empty string", ""],
      ["null status", null],
      ["unknown status", "some_future_status"],
    ] as const)("%s -> false", (_label, status) => {
      expect(hasAccess(row(status, null, iso(HOUR)), NOW)).toBe(false);
    });
  });

  it("null row -> false", () => {
    expect(hasAccess(null, NOW)).toBe(false);
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

  // ── LOCKSTEP PIN (ENG-1025 SQL rows) ─────────────────────────────────────
  // Same combinations `has_content_access()` answers after ENG-1025. If either
  // side is edited without the other, this table (or the BE SQL agreement
  // test) is the thing that should go red.
  it.each([
    ["active", "1d past", true],
    ["active", "4d past", false],
    ["active", "null", true],
    ["canceled", "future", true],
    ["canceled", "1h past", false],
    ["canceled", "null", false],
    ["lapsed", "future", false],
    ["lapsed", "null", false],
  ] as const)("%s + %s current_period_end -> %s", (status, when, expected) => {
    const cpe =
      when === "1d past"
        ? iso(-DAY)
        : when === "4d past"
          ? iso(-4 * DAY)
          : when === "1h past"
            ? iso(-HOUR)
            : when === "future"
              ? iso(DAY)
              : null;
    expect(hasAccess(row(status, null, cpe), NOW)).toBe(expected);
  });
});
