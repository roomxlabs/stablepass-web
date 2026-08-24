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
  it("references no owner field in any member component or screen", () => {
    const offenders = files.filter((f) => /\bowner/i.test(code(f)));
    expect(offenders).toEqual([]);
  });

  // Betting is guardrail 8, and the STABLE UPDATE panel is new free-text
  // rendering surface, so it is worth pinning at the same time.
  it("renders no odds or bookmaker vocabulary in member components", () => {
    const banned = /\b(bookmaker|betfair|sportsbet|wagering|each-way odds)\b/i;
    const offenders = files.filter((f) => banned.test(code(f)));
    expect(offenders).toEqual([]);
  });
});
