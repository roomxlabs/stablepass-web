// horse-name — presentation-only text helpers. Nothing here touches data;
// callers keep the raw `racing_name` for queries, keys and comparisons.
//
// This is a PORT of mobile's `src/components/format.ts` (`displayHorseName`),
// round 6 / ENG-761 mirroring ENG-760. The two codebases are deliberately
// separate — no shared package — so the rule is restated in full here rather
// than referenced, and the two test matrices are kept in step case-for-case.
// If you change a rule here, change it there in the same round.

/**
 * The one registrar suffix we drop on sight. Locally bred is the default in an
 * Australian stable, so "(AUS)" is noise on every card and row (round-6
 * decision, 24 Aug 2026); a genuine import code — (NZ), (GB), (IRE) — is
 * information and stays. Matched case-insensitively; the data is nominally
 * ALL-CAPS but nothing enforces it.
 */
const AUS_SUFFIX = /^\(aus\)$/i;

/**
 * Racing names arrive in the registrar's ALL-CAPS form ("CANNONBROOK (AUS)").
 * Set in caps beside sentence-case UI they read as shouting — part of what the
 * client called "clunky. old" on the Post card (10 Aug 2026). Web rendered the
 * raw registrar string until now, which is why web and mobile disagreed on
 * every horse name. Display them in title case, Instagram-style, without
 * rewriting the data:
 *
 *  - "(AUS)" is dropped entirely — see AUS_SUFFIX above;
 *  - any OTHER parenthesised registrar suffix ("(NZ)", "(GB)") stays exactly as
 *    it arrives — it is a country code, not a word;
 *  - only a FULLY-uppercase word is transformed; mixed case ("McLaren",
 *    "Zaaki's") is someone's deliberate casing and passes through untouched;
 *  - capitalisation restarts after an apostrophe or hyphen ("D'ARGENTO" →
 *    "D'Argento", "RED-HOT" → "Red-Hot").
 *
 * Display-only: `racing_name` in the database keeps the registrar truth, so
 * search, keys and comparisons are unaffected.
 */
export function displayHorseName(name: string): string {
  // Dropping the token with `filter` (rather than blanking it in place) is what
  // keeps the spacing honest: `join(' ')` below re-inserts exactly one
  // separator between the words that survive, so the drop cannot leave a double
  // space mid-name or a stray one at either end. Whitespace that was already in
  // the input is left exactly as it arrived, with or without a suffix — this
  // function strips a suffix, it does not reformat the name around it.
  const kept = name.split(" ").filter((word) => !AUS_SUFFIX.test(word));

  return kept
    .map((word) => {
      if (/^\(.+\)$/.test(word)) return word; // registrar country suffix
      // Not all-caps (or no letters at all) — deliberate casing, keep it.
      if (word !== word.toUpperCase() || !/[A-Z]/.test(word)) return word;
      return word
        .toLowerCase()
        .replace(
          /(^|['’-])(\p{L})/gu,
          (_match, boundary: string, letter: string) => boundary + letter.toUpperCase(),
        );
    })
    .join(" ");
}

/**
 * The nullable-safe wrapper the render sites actually call. Every member screen
 * reaches a horse name through the same `racing_name ?? display_name ?? fallback`
 * shape, and threading `?? ""` through each of them is how one of them ends up
 * rendering "undefined". Returns "" for null/undefined so a caller's own `||`
 * fallback still fires.
 */
export function displayHorseNameOrEmpty(name: string | null | undefined): string {
  if (!name) return "";
  return displayHorseName(name);
}
