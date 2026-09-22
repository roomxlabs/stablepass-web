import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";

// ENG-1324 TURNED THIS FILE AROUND. Read this before editing it.
//
// It used to be ENG-1003's guard, banning /free trial/, /30 days free/,
// /30 days,? on us/ and /no credit card/ from the funnel: the trial had been
// retired and the guard kept its copy from creeping back.
//
// Pricing v2 (ENG-1321) reinstates the trial — 30 days free, then A$9.99 per
// month, the same price on the website, the App Store and Google Play — so the
// old bar is not merely obsolete, it would fail the copy we now ship on purpose.
// The trial copy is no longer the thing to keep out. THE OLD PRICE IS.
//
// THE PATTERN LIST IS STILL THE WHOLE TEST, and the original's hard-won lesson
// carries over unchanged, so it is repeated here rather than left in git
// history: write the patterns against THE STRINGS THAT ACTUALLY EXISTED, never
// against the phrase. ENG-1003's first draft banned the phrase "free trial" and
// would have waved through the single largest piece of trial copy on the site,
// because that copy never used the words.
//
// A note on what this bar actually is, because the header used to over-claim it:
// it is NOT "any bare 19 anywhere". A naked `const PRICE_AUD = 19;` is invisible
// to a line-oriented grep that must also leave `const GRID = 19` alone, and
// pretending otherwise would be the same false comfort this file exists to warn
// about. The enforced bar is: **a 19 wearing a currency sign, or a 19 sitting
// next to a period word on the same line** — which is every form the retired
// price actually took on this site.
//
// The same trap, in its Pricing v2 shape, is the price card. The old markup was
//
//     <div className="price-num">
//       $19<small>/month</small>
//     </div>
//
// so a pattern written against the PHRASE — /19 per month/, /nineteen dollars/,
// even /19\/month/ — matches nothing at all there: the number and the period are
// separated by a JSX tag. That line was the biggest, boldest price on the page.
// Hence the rule below: the bar is the bare `19` LITERAL, matched either by its
// currency sign or by a period word that a tag is allowed to sit in front of.
const BANNED = [
  // `$19`, `A$19`, `AU$19`, `$19.00`, `$ 19` — the literal wearing its sign.
  /A?U?\$\s*19\b/i,
  // The other half of the retirement (ENG-1321, decision 5): the six-month promo.
  // The `19` bar alone would let "$9/month for your first 6 months" creep back,
  // and that string is now one character from the LIVE price — a stray promo line
  // reads as almost-correct, which is the worst kind of wrong. Matched on the
  // promo's own phrase, which `A$9.99 per month` cannot collide with.
  /first (?:6|six) months/i,
  // The same number with no sign, next to a period word: "19 per month",
  // "19/month", "19 a month", "19.00 per month". `(?:<[^>]*>)?` is the whole
  // point — it steps over the `<small>` in `$19<small>/month</small>`, so the
  // price card is caught twice over rather than not at all.
  /\b19(?:\.\d{2})?\s*(?:<[^>]*>)?\s*(?:\/\s*|per |a )month/i,
];

// Every root that renders a price to a member or a visitor. The bar is ZERO
// hits and stays zero — there is no pending list, because ENG-1324 left no
// offender behind in any of them.
//
// `app/(member)` is scanned but NOT edited by ENG-1324: those screens are W3's
// (ENG-1328) and they must keep retrieving the amount from Stripe rather than
// printing a literal. Scanning a root you do not own is the point — this guard
// is what makes "never hardcode the price" checkable instead of aspirational.
//
// A root named in no list is not scanned at all. If a root ever genuinely needs
// a temporary exception, give it a TEXT-KEYED allowlist (never a line number:
// line numbers couple this file to a sibling branch's whitespace and rot
// silently in both directions) and promote it back to zero when the owner
// lands — deleting an entry without promoting the root silently stops covering
// it.
const PRICED_ROOTS = ["app/(marketing)", "app/start", "app/signin", "app/(member)", "components"];

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
      // the old price (like the ones at the top of this file, and the ones
      // ENG-1324 left in the marketing sections explaining what changed) cannot
      // trip a guard meant for copy a member reads.
      if (line.trim().startsWith("//")) return;
      if (BANNED.some((pattern) => pattern.test(line))) {
        hits.push({ at: `${relative(process.cwd(), file)}:${i + 1}`, text: line.trim() });
      }
    });
  }

  return hits;
}

describe("no A$19 price literal survives anywhere a member can read one", () => {
  for (const root of PRICED_ROOTS) {
    it(`scans every .ts/.tsx file under ${root}`, () => {
      expect(
        offendersUnder(root).map((h) => `${h.at}: ${h.text}`),
        `the price is A$9.99 after a 30-day trial (ENG-1321) — and a checkout screen must read it from Stripe, not print a literal`,
      ).toEqual([]);
    });
  }
});

/**
 * NON-VACUITY PIN.
 *
 * A grep guard whose patterns have quietly stopped matching anything reports a
 * perfect green, and `.rx/gotchas.md` records this repo losing a real red to
 * exactly that (ENG-991: a fidelity guard that skipped when its fixture was
 * unreachable went from "1 failed" to "all green"). The scan above can rot the
 * same way — a refactor to `BANNED`, or a walk that silently returns no files,
 * and it passes forever while checking nothing.
 *
 * So the patterns are exercised here against the strings that were actually on
 * the site before ENG-1324, including the JSX-split price card, and against the
 * copy we now ship on purpose. If someone weakens a pattern, this goes red in
 * the same run.
 */
describe("the guard itself still bites", () => {
  const matches = (line: string) => BANNED.some((p) => p.test(line));

  it.each([
    ["$19 per month for behind-the-scenes racing content from participating stables."],
    ["$19<small>/month</small>"],
    ["$19/month thereafter. Cancel anytime. No lock-in contract."],
    ["Join stablepass. $9/month for your first 6 months, then $19/month."],
    ["stablepass. subscription is $19 per month."],
    ['a: "… pay $9 per month for their first 6 months, then $19 per month thereafter."'],
    ['const PRICE = "A$19.00";'],
    ["19 per month"],
    ["Launch Offer \u2014 $9/month for your first 6 months."],
    ["pay $9 per month for their first six months"],
  ])("catches the retired price literal: %s", (line) => {
    expect(matches(line)).toBe(true);
  });

  it.each([
    ["30 days free, then A$9.99 per month. Cancel anytime."],
    ["A$9.99<small>/month</small>"],
    ["The same A$9.99 per month on the website, the App Store and Google Play."],
    ["Start your 30 days free"],
    // The bar is a PRICE literal, not the digits. These must stay green or the
    // guard becomes a tax on unrelated code.
    ["const GRID = 19;"],
    ["signed up on 19 September 2026"],
    ["unitAmount: 1900,"],
    ['width={19} height={19}'],
    // The live price must never collide with the promo pattern above.
    ["A$9.99 per month, billed monthly"],
    ["30 days free, then A$9.99"],
  ])("leaves legitimate copy and code alone: %s", (line) => {
    expect(matches(line)).toBe(false);
  });

  it("actually walked the tree — every scanned root yielded source files", () => {
    for (const root of PRICED_ROOTS) {
      expect(sourceFiles(root).length, `no .ts/.tsx found under ${root} — the walk is broken`).toBeGreaterThan(0);
    }
  });
});
