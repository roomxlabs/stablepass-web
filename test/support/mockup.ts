import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Resolving the marketing mockup — the fixture every marketing fidelity guard
 * compares against.
 *
 * The mockup lives in a sibling design tree OUTSIDE this repo
 * (`<workspace>/10-marketing-site/deploy/src/mockup.html`), so its depth above the
 * repo root differs between a normal checkout and one of the rx loop's worktrees.
 *
 * ENG-991: every marketing test file used to carry its OWN copy of a resolver that
 * walked up from `process.cwd()` only. From a git worktree outside the repo tree
 * (`~/.claude/jobs/<id>/` — where rx implement/review workers actually run) that walk
 * never reaches the workspace, so the resolver returned null and the guards either
 * silently failed to register or silently skipped. Measured on this branch:
 *
 *   test/marketing-shell.test.tsx   real checkout: 36 tests, 1 failed
 *                                   ~/.claude/jobs: 29 tests, ALL GREEN
 *   test/marketing-home.test.tsx    real checkout: 26 tests, 1 FAILED
 *                                   ~/.claude/jobs: 26 tests, PASSED (1 skipped)
 *
 * In both cases a REAL failure disappeared and the run reported success. That is why
 * every "full suite green" an agent claimed on a marketing PR was untrustworthy.
 *
 * Two rules fix it, and they live here so no file can drift from them again:
 *
 *   1. Resolve from the **git common dir** as well as the cwd. `git rev-parse
 *      --git-common-dir` points at the ORIGINAL checkout's `.git` even inside a
 *      linked worktree, so walking up from there reaches the workspace from any
 *      worktree location. `.rx/mockups.md` already prescribes exactly this trick.
 *   2. Never skip silently — callers use `mockupOrThrow()` inside the test body, so
 *      the tests still REGISTER and go red with a diagnostic.
 *
 * Tradeoff considered: a checked-in copy of the mockup would remove the external
 * dependency entirely, but it also removes the point of the guard — the assertion is
 * "our CSS still matches the DESIGNER'S live file", and a copy would only ever prove
 * we still match our own copy. `$STABLEPASS_MARKETING_MOCKUP` is the escape hatch for
 * a CI box that mounts the design tree somewhere else.
 */
export const MOCKUP_SUFFIX = "10-marketing-site/deploy/src/mockup.html";
export const MOCKUP_ENV_VAR = "STABLEPASS_MARKETING_MOCKUP";

/** Walk up from `start`, returning the first ancestor that holds the mockup. */
function walkUpFor(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, MOCKUP_SUFFIX);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The original checkout's root, even when this process runs inside a linked worktree. */
function mainCheckoutRoot(cwd: string): string | null {
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // `<main checkout>/.git` -> `<main checkout>`
    return commonDir ? path.dirname(commonDir) : null;
  } catch {
    // Not a git dir, or a git too old for `--path-format` (needs >= 2.31).
    // Degrade to the cwd walk rather than guessing a path.
    return null;
  }
}

/** Every location consulted, for the error message when nothing is found. */
export const MOCKUP_SEARCHED: string[] = [];

function findMockup(): string | null {
  const cwd = process.cwd();
  const override = process.env[MOCKUP_ENV_VAR];
  if (override) {
    MOCKUP_SEARCHED.push(`$${MOCKUP_ENV_VAR}=${override}`);
    // A directory would satisfy existsSync but is never a usable mockup.
    return existsSync(override) && statSync(override).isFile() ? override : null;
  }
  for (const start of [cwd, mainCheckoutRoot(cwd)]) {
    if (!start) continue;
    MOCKUP_SEARCHED.push(`upward from ${start}`);
    const hit = walkUpFor(start);
    if (hit) return hit;
  }
  return null;
}

export const MOCKUP = findMockup();

/**
 * The loud failure. Call this from INSIDE a test body (never at describe scope), so
 * the test still registers and goes red with the paths actually searched. That is the
 * ENG-991 invariant: a fidelity guard may fail, but it may never quietly cease to exist.
 */
export function mockupOrThrow(): string {
  if (MOCKUP) return MOCKUP;
  throw new Error(
    `marketing CSS fidelity guard: mockup fixture not found (expected \`${MOCKUP_SUFFIX}\` in an ` +
      `ancestor of this checkout).\nSearched:\n  - ${MOCKUP_SEARCHED.join("\n  - ")}\n` +
      `This guard MUST NOT be skipped: it is the only check that the marketing port still matches ` +
      `the designer's file. Point \`$${MOCKUP_ENV_VAR}\` at the mockup, or run from a checkout whose ` +
      `workspace contains the design tree.`,
  );
}
