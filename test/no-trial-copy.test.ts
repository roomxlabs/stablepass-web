import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

// ENG-1003 retired the free trial from the signup funnel. This is a grep-style
// guard against the copy that pitched it coming back.
//
// It is a REAL guard, not scoped to the files this ticket touched — it walks
// each root recursively, so any future file under them is covered.
//
// THE PATTERN LIST IS THE WHOLE TEST, so it is written against the strings that
// actually existed rather than against the phrase "free trial". The first
// version of this file banned /free trial/, /30 days free/ and /30 days, on us/
// — and the retired aside quote was "30 days on us — no credit card, no
// auto-charge", which has no comma and contains neither of the other two. The
// guard would have waved back in the single largest piece of trial copy it was
// written to keep out. Optional comma, and `no credit card` in its own right:
// with nothing to be free of, offering to not ask for a card is the same pitch.
const BANNED = [
  /free trial/i,
  /30 days free/i,
  /30 days,? on us/i,
  /no credit card/i,
  /\bfree for \d+ days/i,
  /\bdays,? (?:on|free) (?:us|of)\b/i,
];

// The funnel itself. ENG-1003 owns every file under these, so the bar is zero
// hits and stays zero.
const FUNNEL_ROOTS = ["app/start", "app/signin"];

// Roots where trial copy still exists and is NOT this slice's to remove. Each
// entry names the exact offending text, so the assertion is "the offenders are
// a SUBSET of these" rather than "equal to these".
//
// Keyed on TEXT, never on a line number. The comment-stripping below preserves
// the line count precisely so a reported line is a real one — but an allowlist
// keyed on line numbers is still coupled to a sibling branch's whitespace, and
// it rots silently in both directions: a comment added above shifts the number
// and false-reds their PR, while a genuinely NEW trial string landing on the
// allowed line is waved straight through. Text has neither failure mode.
//
// This gives the property worth having in all three directions:
//   - NEW trial copy under any of these roots goes red today;
//   - the owning ticket deleting its line does NOT turn this red on their
//     branch, so the guard cannot hold their PR hostage;
//   - once they land, the entry is dead and should be deleted, at which point
//     that root gets the same zero bar as the funnel.
const PENDING_ROOTS: Record<string, string[]> = {
  // ENG-1002 (P4 — member cancel, the /account UI, hasAccess()). In progress in
  // a sibling worktree; editing it here would break the collision guarantee.
  "app/(member)": [
    "You're on a free trial. When it ends you can choose to buy 30 days — nothing happens automatically and we have no card on file.",
    "Your free trial has ended. Buy 30 days to pick up where you left off.",
  ],
  // Owned by NOBODY yet — ENG-999 + ENG-1003 together are what made this copy
  // wrong, and a never-trialled account is now told its trial ended. Raised as
  // a follow-up on ENG-1003; scanned here so the guard tells the truth about
  // the copy a signed-up member actually sees, which does not all live under
  // app/(member).
  components: [
    "Your free trial has ended",
    "Your 30 days are up. Buy 30 days of full access to pick up where you left off.",
  ],
  "app/onboarding": ["30 days free"],
};

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

function sourceFiles(root: string): string[] {
  return filesUnder(resolve(process.cwd(), root)).filter((f) => /\.(ts|tsx)$/.test(f));
}

/** Every line of member-visible copy matching a banned pattern. */
function offendersUnder(root: string): { at: string; text: string }[] {
  const hits: { at: string; text: string }[] = [];

  for (const file of sourceFiles(root)) {
    const raw = readFileSync(file, "utf8");
    // Blank out block comments WITHOUT collapsing them, so the reported line
    // number is the real one. A plain `.replace(…, "")` deletes the newlines
    // inside the comment and silently shifts every line after it.
    const body = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""));
    body.split("\n").forEach((line, i) => {
      // Skip a line that is itself a // comment, so an engineering note ABOUT
      // the trial (like the one at the top of this file) cannot trip a guard
      // meant for copy a member reads.
      if (line.trim().startsWith("//")) return;
      if (BANNED.some((pattern) => pattern.test(line))) {
        hits.push({ at: `${relative(process.cwd(), file)}:${i + 1}`, text: line.trim() });
      }
    });
  }

  return hits;
}

describe("no free-trial copy remains in the signup funnel", () => {
  for (const root of FUNNEL_ROOTS) {
    it(`scans every .ts/.tsx file under ${root}`, () => {
      expect(offendersUnder(root).map((h) => `${h.at}: ${h.text}`)).toEqual([]);
    });
  }
});

describe("the member-facing app grows no NEW free-trial copy", () => {
  for (const [root, pending] of Object.entries(PENDING_ROOTS)) {
    it(`scans every .ts/.tsx file under ${root}`, () => {
      const unexpected = offendersUnder(root)
        .filter((hit) => !pending.some((known) => hit.text.includes(known)))
        .map((hit) => `${hit.at}: ${hit.text}`);

      expect(
        unexpected,
        `new free-trial copy under ${root} — the trial is retired (ENG-999/ENG-1003)`,
      ).toEqual([]);
    });
  }
});
