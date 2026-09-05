// Guardrail 2 — "No PHI/PII-equivalent leak — no owner identity, ever."
//
// `.rx/guardrails.md` has always DECLARED this test ("grep guard — no `owner`
// field usage in components") and it did not exist. ENG-613 is the first change
// to put trainer identity (`stable_name`, `location`) on the member card, and
// its new projection tests are an allow-list of REQUIRED columns — which can
// never catch a projection being WIDENED. Widening is exactly how an owner
// column would arrive on the card, so the guard is written here.
//
// Whitespace is collapsed before matching: a guard that scans raw text is
// defeated by a line wrap, and these projections are long enough to wrap.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["components", join("app", "(member)")];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Strip comments, then collapse whitespace — a line wrap must not defeat this. */
function code(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/\s+/g, " ");
}

describe("guardrail 2 — no owner identity anywhere in member UI", () => {
  const files = ROOTS.flatMap((r) => sourceFiles(join(process.cwd(), r))).map((f) =>
    f.slice(process.cwd().length + 1),
  );

  it("scans a non-trivial set of files (the guard must not pass by finding nothing)", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.includes("post-card"))).toBe(true);
  });

  // There is no owner field anywhere in this product. A component that tries to
  // show one is a bug, and a `.select()` that fetches one is a leak — `sb` is
  // untyped, so nothing else would catch it.
  //
  // ONE SIGNED-OFF SENTENCE IS ALLOW-LISTED (ENG-956) — the WORD is not.
  // Mobile's Shares empty state reads "Horses with ownership shares for sale
  // will show up here.", ported verbatim, and `\bowner` matches inside
  // "ownership". Rewording web-only would create exactly the drift the ticket
  // exists to remove, so the sentence is scrubbed out of the source before the
  // scan and the regex itself stays UNTOUCHED.
  //
  // Deliberately NOT a `/\bowner(?!ship\b)/` lookahead: that exempts the whole
  // word family, so a future `sb.from("ownership").select("email")` or
  // `ownership.name` — the natural spelling for a syndicate/owner entity on a
  // SHARES screen, i.e. precisely this surface — would pass the guard silently.
  // Allow-listing the literal string fails the build the instant any OTHER
  // `ownership*` token appears, and is auditable as "one sentence is exempt".
  const ALLOWED_COPY = ["Horses with ownership shares for sale will show up here."];
  const scrub = (src: string) =>
    ALLOWED_COPY.reduce((acc, phrase) => acc.split(phrase).join(" "), src);

  it("references no owner field in any member component or screen", () => {
    const offenders = files.filter((f) => /\bowner/i.test(scrub(code(f))));
    expect(offenders).toEqual([]);
  });

  // The allow-list must not become a hole: the regex is unchanged, so every
  // owner spelling — INCLUDING every `ownership*` identity read — still trips.
  it("still catches every owner-IDENTITY spelling (the allow-list is one sentence, not a word)", () => {
    for (const leak of [
      "owner",
      "owners",
      "owner_name",
      "owner_email",
      "ownerId",
      "ownerName",
      "sb.from('horse').select('owner_id')",
      // `ownership`-PREFIXED IDENTITY READS — the shapes a word-family
      // lookahead would have let through, on exactly this surface.
      'sb.from("ownership").select("email")',
      "ownership.email",
      "const ownership = row.ownership",
      "Ownership: Chris Waller",
      "ownership_name",
      "ownerships",
    ]) {
      expect(/\bowner/i.test(scrub(leak)), leak).toBe(true);
    }
    // Only the one signed-off sentence is scrubbed, and only in full.
    expect(/\bowner/i.test(scrub("Horses with ownership shares for sale will show up here."))).toBe(
      false,
    );
  });

  // Betting is guardrail 8, and the STABLE UPDATE panel is new free-text
  // rendering surface, so it is worth pinning at the same time.
  it("renders no odds or bookmaker vocabulary in member components", () => {
    const banned = /\b(bookmaker|betfair|sportsbet|wagering|each-way odds)\b/i;
    const offenders = files.filter((f) => banned.test(code(f)));
    expect(offenders).toEqual([]);
  });
});
