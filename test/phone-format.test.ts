import { describe, it, expect } from "vitest";

import { normalizePhone } from "@/lib/format/phone";

// The pass/fail for ENG-763's phone pre-check.
//
// `normalizePhone` is a port of `public.normalize_phone(text)`, shipped by
// ENG-742 in stablepass-be's 20260819120003_phone_unique.sql. THE MATRIX BELOW
// IS COPIED CASE-FOR-CASE from that ticket's own suite,
// stablepass-be/test/rls/phone-unique.test.mjs, so that a change to the SQL rule
// turns both repos red instead of leaving this side to drift quietly.
//
// Drift is not cosmetic here. The web route asks the database
// `phone_in_use(p_phone)` with the number AS TYPED, and uses this helper only to
// skip the round trip when the value cannot possibly be in use. If this function
// answers null where the SQL answers a real key, the check is skipped, a repeat
// signup walks through the wall, and the member silently gets a second trial
// with their phone dropped to NULL. Nothing else in the stack notices.
//
// If you change a case here, change it in stablepass-be in the same round.
describe("normalizePhone — mirrors public.normalize_phone (ENG-742)", () => {
  // Verbatim from phone-unique.test.mjs's `normalize_phone(text)` matrix.
  it.each([
    [null, null],
    ["", null],
    [" ", null],
    ["0400 111 222", "61400111222"],
    ["+61 400 111 222", "61400111222"],
    ["61400111222", "61400111222"],
    ["(04) 1234-5678", "61412345678"],
    ["+44 7700 900123", "447700900123"],
    ["abc", null],
    ["----", null],
  ])("normalizePhone(%j) -> %j", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  // `undefined` has no SQL counterpart (the RPC parameter is either passed or
  // it is not), but the TS caller reads an optional field, so it is pinned here
  // as the coalesce(p_phone,'') equivalent.
  it("treats undefined like null, not like the string 'undefined'", () => {
    expect(normalizePhone(undefined)).toBe(null);
  });

  it("returns null, never the empty string, for a value with no digits", () => {
    // Load-bearing on the database side: NULLs never conflict in a unique btree
    // index but empty strings DO, so if garbage normalised to "" the first
    // member to type junk would own it and every later junk-phone signup would
    // collide with them. Pinned as an identity check, not just falsiness.
    for (const junk of ["abc", "----", " ", "", "()+ -", null]) {
      expect(normalizePhone(junk)).toBe(null);
    }
  });

  it("collapses every format a member might type for one number to one key", () => {
    // The acceptance criterion: a second signup in a DIFFERENT format is still
    // the same number.
    const keys = [
      "0400 111 222",
      "0400111222",
      "+61 400 111 222",
      "+61400111222",
      "61400111222",
      "(0400) 111-222",
      "0400.111.222",
      "  0400 111 222  ",
    ].map(normalizePhone);

    expect(new Set(keys)).toEqual(new Set(["61400111222"]));
  });

  it("is idempotent — normalising an already-normalised key does not move it", () => {
    // Relied on implicitly: a normalised key never starts with 0 (the rule
    // rewrote it), so the 0 -> 61 step cannot fire a second time.
    const once = normalizePhone("0400 111 222");
    expect(normalizePhone(once)).toBe(once);
  });

  // ---- the 20-digit safety valve, from phone-unique.test.mjs -----------------
  // Not a validator: an oversized key raises 54000 inside the signup trigger,
  // which would 500 the whole signup. The cap sits above E.164's 15 digits, so
  // it cannot reject a real number. Measured AFTER the 0 -> 61 expansion.
  it.each([
    ["6", 20, true], // 20 digits, no expansion -> kept
    ["6", 21, false], // 21 digits -> null
    ["0", 19, true], // 19 typed -> 20 after 0 -> 61 -> kept
    ["0", 20, false], // 20 typed -> 21 after 0 -> 61 -> null
  ])("%s repeated %i times is kept=%s", (char, count, kept) => {
    const input = (char as string).repeat(count as number);
    const expected = kept ? input.replace(/^0/, "61") : null;
    expect(normalizePhone(input)).toBe(expected);
  });

  // ---- known limits, pinned so they stay KNOWN --------------------------------
  // Both are documented in the migration and in stablepass-be's
  // docs/specs/api-contract.md, and both are pinned on the backend side too.
  // They are wrong on purpose: the fix is real E.164 parsing (libphonenumber),
  // which is out of scope. If one of these ever starts passing, the SQL changed
  // and this file must be re-synced.
  it("KNOWN LIMIT (false match): two DIFFERENT real numbers collide", () => {
    // NZ national vs an AU landline. The 0 -> 61 rule fires on any leading
    // zero, so the second of these two real people is told they already had a
    // trial. This is the user-visible cost of the heuristic.
    expect(normalizePhone("021 400 1112")).toBe(normalizePhone("+61 2 1400 1112"));
    expect(normalizePhone("021 400 1112")).toBe("61214001112");
  });

  it("KNOWN LIMIT (missed match): the 00 international prefix is not stripped", () => {
    // An ordinary AU number dialled internationally. Costs an extra trial
    // rather than blocking anyone, which is the safer direction of the two.
    expect(normalizePhone("0061 400 111 222")).not.toBe(normalizePhone("0400 111 222"));
    expect(normalizePhone("0061 400 111 222")).toBe("61061400111222");
  });
});
