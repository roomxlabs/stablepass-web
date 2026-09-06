import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

// ENG-1003 retired the free trial from the signup funnel. This is a grep-style
// guard against the copy that pitched it coming back.
//
// It is a REAL guard, not scoped down to the files this ticket touched — it
// walks each root recursively, so any future file under them is covered
// automatically.
const BANNED = [/free trial/i, /30 days free/i, /30 days, on us/i];

// The funnel itself. ENG-1003 owns every file under these two, so the bar is
// zero hits and stays zero.
const FUNNEL_ROOTS = ["app/start", "app/signin"];

// The member area is a SUBSET check, not a zero check, and the difference is
// deliberate. `app/(member)/account/**` is ENG-1002's live surface (P4 — member
// cancel, the /account UI, and hasAccess() mirroring the new gate), and it is
// In Progress in a sibling worktree right now. Its trial copy is ENG-1002's to
// remove, not this slice's; editing it here would break the collision guarantee
// the whole loop rests on.
//
// So these two lines are named explicitly and allowed, and the assertion is
// "the offenders are a SUBSET of this list" rather than "the offenders equal
// it". That gives the property worth having in all three directions:
//   - a NEW piece of trial copy anywhere under app/(member) goes red today;
//   - ENG-1002 deleting these two lines does NOT turn this test red on their
//     branch, so the guard cannot hold their PR hostage;
//   - once it lands, this constant is dead and should be emptied, at which
//     point the member area gets the same zero bar as the funnel.
const MEMBER_ROOT = "app/(member)";
const KNOWN_PENDING_ENG_1002 = [
  "app/(member)/account/page.tsx:199",
  "app/(member)/account/page.tsx:205",
];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function sourceFiles(root: string): string[] {
  return filesUnder(resolve(process.cwd(), root)).filter((f) => /\.(ts|tsx)$/.test(f));
}

/** `path:line` for every line of member-visible copy matching a banned pattern. */
function offendersUnder(root: string): string[] {
  const hits: string[] = [];

  for (const file of sourceFiles(root)) {
    const raw = readFileSync(file, "utf8");
    // Strip block comments, then skip any line that is itself a // comment, so
    // an engineering note ABOUT the trial (like the one at the top of this
    // file) cannot trip a guard meant for copy a member reads.
    const body = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    body.split("\n").forEach((line, i) => {
      if (line.trim().startsWith("//")) return;
      if (BANNED.some((pattern) => pattern.test(line))) {
        hits.push(`${relative(process.cwd(), file)}:${i + 1}`);
      }
    });
  }

  return hits;
}

describe("no free-trial copy remains in the signup funnel", () => {
  for (const root of FUNNEL_ROOTS) {
    it(`scans every .ts/.tsx file under ${root}`, () => {
      expect(offendersUnder(root)).toEqual([]);
    });
  }
});

describe("the member area grows no NEW free-trial copy", () => {
  it(`scans every .ts/.tsx file under ${MEMBER_ROOT}`, () => {
    const unexpected = offendersUnder(MEMBER_ROOT).filter(
      (hit) => !KNOWN_PENDING_ENG_1002.includes(hit),
    );
    expect(
      unexpected,
      "new free-trial copy under app/(member) — the trial is retired (ENG-999/ENG-1003)",
    ).toEqual([]);
  });
});
