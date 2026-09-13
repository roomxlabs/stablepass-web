// ENG-1062 — the e2e password locator may never be ambiguous again.
//
// `components/password-input.tsx` renders the reveal toggle as
// `<button aria-label="Show password">` (or "Hide password" once revealed).
// Playwright's `getByLabel` matches an accessible name by SUBSTRING and
// case-insensitively unless `{ exact: true }` is passed, so
// `getByLabel("Password")` matches the toggle as well as the input and every
// sign-in helper written that way dies with a strict-mode violation — at the
// LOGIN step, before the test under review runs. That is how 68 of 169 tests
// went dark for nine days without anyone reading it as a locator bug.
//
// The runtime half of the fix lives in `e2e/helpers/sign-in.ts` (`fillPassword`
// asserts the locator resolved to exactly one node). This is the static half:
// it stops the ambiguous form being reintroduced at all, in a suite that no CI
// job currently runs.
//
// Only `e2e/` is scanned. This file cannot scan `test/`, because this file must
// itself spell out the pattern it forbids.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const E2E_ROOT = join(process.cwd(), "e2e");

/**
 * The reveal toggle's two accessible names. A label query is ambiguous exactly
 * when its name is a substring of one of these — "Password" is, "New password"
 * is not (which is why the reset-password spec's queries are fine).
 */
const TOGGLE_NAMES = ["show password", "hide password"];

function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...specFiles(full));
    else if (/\.[cm]?[jt]sx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Strip comments — every spec here *describes* the forbidden call in prose.
 *
 * Line comments are stripped only when they START the line. The strip-anything-
 * after-an-unprefixed-slash-slash form used elsewhere in this repo (to dodge
 * "https://") is wrong HERE: it also blanks everything after a slash-slash that
 * sits inside a string literal, so `const u = "a//b";` followed by a real
 * forbidden call on the same line would scan clean. In a guard a false negative
 * is silent and a false positive is loud, so this errs loud. Every real comment
 * in `e2e/` today is line-initial; a trailing comment that quotes the forbidden
 * call will trip the guard, and the fix is to reword the comment.
 */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/[^\n]*$/gm, " ");
}

function code(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/**
 * `getByLabel("name")` / `getByLabel('name', { ...opts })` — quoted names.
 *
 * The options group and a trailing comma are BOTH optional and independent:
 * `getByLabel("Password",)` is what a `trailingComma: "all"` formatter emits
 * when the call wraps, and an earlier draft of this regex let exactly that
 * slip through unflagged.
 */
const STRING_LABEL =
  /getByLabel\(\s*(["'`])([^"'`]*)\1\s*(?:,\s*(?:\{([^}]*)\})?)?\s*,?\s*\)/g;
/** `getByLabel(/name/i)` — regex names, the obvious way around the above. */
const REGEX_LABEL = /getByLabel\(\s*\/([^/\n]+)\/([a-z]*)\s*\)/g;

function ambiguousQueries(source: string): string[] {
  const hits: string[] = [];

  for (const m of source.matchAll(STRING_LABEL)) {
    const [, , name, opts = ""] = m;
    // `{ exact: true }` turns off substring matching, so it is never ambiguous.
    if (/\bexact\s*:\s*true\b/.test(opts)) continue;
    if (TOGGLE_NAMES.some((toggle) => toggle.includes(name.trim().toLowerCase()))) {
      hits.push(m[0]);
    }
  }

  for (const m of source.matchAll(REGEX_LABEL)) {
    const [, pattern, flags] = m;
    let re: RegExp;
    try {
      re = new RegExp(pattern, flags.replace("g", ""));
    } catch {
      continue;
    }
    if (TOGGLE_NAMES.some((toggle) => re.test(toggle))) hits.push(m[0]);
  }

  return hits;
}

describe("ENG-1062 — no e2e spec may locate the password field by label", () => {
  const files = specFiles(E2E_ROOT);

  it("scans a non-trivial set of specs (the guard must not pass by finding nothing)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("video-poster.spec.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith(join("helpers", "sign-in.ts")))).toBe(true);
  });

  it("catches the exact form that broke the suite", () => {
    expect(ambiguousQueries('page.getByLabel("Password").fill(p)')).toHaveLength(1);
    expect(ambiguousQueries("page.getByLabel('Password').fill(p)")).toHaveLength(1);
    expect(ambiguousQueries('page.getByLabel("password").fill(p)')).toHaveLength(1);
    expect(ambiguousQueries("page.getByLabel(/password/i).fill(p)")).toHaveLength(1);
    expect(ambiguousQueries('page.getByLabel("Password", { exact: false })')).toHaveLength(1);
    // A trailing comma is what a `trailingComma: "all"` formatter emits when the
    // call wraps. Both of these once scanned clean.
    expect(ambiguousQueries('page.getByLabel("Password",).fill(p)')).toHaveLength(1);
    expect(ambiguousQueries('page.getByLabel("Password", { timeout: 1 },)')).toHaveLength(1);

    // Unambiguous forms must NOT be flagged.
    expect(ambiguousQueries('page.getByLabel("Password", { exact: true })')).toHaveLength(0);
    expect(ambiguousQueries('page.getByLabel("New password", { exact: true })')).toHaveLength(0);
    expect(ambiguousQueries('page.getByLabel("Confirm new password")')).toHaveLength(0);
    expect(ambiguousQueries('page.getByLabel("Email").fill(e)')).toHaveLength(0);
    // The role query is whole-string against a <button>, so it is safe.
    expect(ambiguousQueries('page.getByRole("textbox", { name: "Password" })')).toHaveLength(0);
  });

  it("strips real comments, but a `//` inside a string cannot blank a real call", () => {
    // A line-initial comment describing the defect is prose, not a defect.
    expect(
      ambiguousQueries(stripComments('  // never write page.getByLabel("Password")\nconst a = 1;')),
    ).toHaveLength(0);
    expect(ambiguousQueries(stripComments('/* page.getByLabel("Password") */\nconst a = 1;'))).toHaveLength(0);
    // ...but a `//` inside a string literal must not swallow the rest of the line.
    expect(
      ambiguousQueries(stripComments('const u = "a//b"; page.getByLabel("Password").fill(p);')),
    ).toHaveLength(1);
  });

  it.each(files.map((f) => [f.slice(process.cwd().length + 1), f]))(
    "%s uses a locator the reveal toggle cannot match",
    (_label, full) => {
      expect(
        ambiguousQueries(code(full)),
        "use `fillPassword(page, …)` from e2e/helpers/sign-in.ts — a label query " +
          "for the password field also matches the reveal toggle's aria-label",
      ).toEqual([]);
    },
  );
});
