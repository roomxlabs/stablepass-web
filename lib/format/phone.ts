// phone — the TypeScript mirror of the database's `public.normalize_phone(text)`.
//
// This is a PORT, not an independent implementation. The authority is ENG-742's
// migration, `supabase/migrations/20260819120003_phone_unique.sql` in
// stablepass-be, which builds the unique index `idx_app_user_phone` on
// `normalize_phone(phone)`. Its SQL body is:
//
//   select case when pg_catalog.length(d) between 1 and 20 then d end
//     from (select pg_catalog.regexp_replace(
//                    pg_catalog.regexp_replace(coalesce(p_phone,''),'[^0-9]','','g'),
//                    '^0','61') as d) q
//
// WHY A MIRROR EXISTS AT ALL, AND WHY DRIFT IS WORSE THAN HAVING NO MIRROR.
// The repeat-signup wall (ENG-763) asks the database `phone_in_use(p_phone)`
// before creating an account. That RPC normalises IN THE BODY, so the wire call
// is made with the number exactly as the member typed it and the DB's own rule
// decides the answer. This helper therefore does NOT decide the wall — it
// decides only whether asking is worth a round trip (a value that normalises to
// null can never be in use, which is the RPC's own documented answer for that
// input). If this function and the SQL ever disagree, that short-circuit starts
// skipping calls the database would have answered `true` to, and a repeat
// signup sails through the wall. The matrix in `test/phone-normalise.test.ts`
// is copied case-for-case from ENG-742's `test/rls/phone-unique.test.mjs` so the
// two suites go red together rather than drifting apart quietly.
//
// !! If ENG-742's SQL rule ever changes, change this in the same round, and
// !! remember the migration's own warning: changing the semantics requires a
// !! REINDEX of idx_app_user_phone, which Postgres will not prompt for.
//
// THIS IS NOT A PHONE-NUMBER PARSER and it is deliberately wrong in both
// directions (documented at length in the migration and in the backend's
// docs/specs/api-contract.md):
//   * MISSED match: the international access prefix `00` is not stripped, so
//     `0061 400 111 222` does not match `0400 111 222`. Costs an extra trial.
//   * FALSE match: `^0 -> 61` fires on ANY leading zero, so NZ `021 400 1112`
//     and AU `+61 2 1400 1112` both normalise to `61214001112`. Two different
//     real people collide, and the second is told they already had a trial.
// Both are pinned as tests on both sides. Real E.164 parsing (libphonenumber)
// is the proper fix and is out of scope here.
//
// Note this is a UNIQUENESS key, not a display value. `app_user.phone` stores
// the trimmed display form the member typed (`+61 400 000 000`); the form's own
// `auParse`/`auFormat` in app/start/trial-start-form.tsx own that shape. Do not
// cross the two: this output is never rendered.

/**
 * The canonical digits-only form used for phone uniqueness comparison, or null
 * when the input carries nothing comparable.
 *
 * Rules, in order (total — every input maps to exactly one output):
 *   1. strip everything that is not a digit;
 *   2. a single leading `0` becomes `61` (AU national to E.164 country code),
 *      so the local and international forms of one number collide as intended;
 *   3. an empty result is null, never `""`;
 *   4. MORE THAN 20 DIGITS is null.
 *
 * Rule 3's null is load-bearing on the database side rather than here: NULLs
 * never conflict in a unique btree index but empty strings do, so if garbage
 * normalised to `""` the first member who typed junk would own it and every
 * later junk-phone signup would collide with them.
 *
 * Rule 4 is a safety valve, not a validator. A btree index tuple cannot exceed
 * 2704 bytes, and without the cap a signup carrying enough high-entropy digits
 * raises `54000` inside the signup trigger, aborting the whole auth.users
 * insert. 20 sits above E.164's 15-digit maximum, so it cannot reject a real
 * number; over-length input is treated as garbage exactly like "abc".
 *
 * The cap is measured AFTER rule 2, matching the SQL: 20 typed digits beginning
 * with `0` become 21 and normalise to null.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  // `coalesce(p_phone, '')` — null and undefined are the empty string, not a
  // crash and not the literal "null".
  const digits = (input ?? "").replace(/[^0-9]/g, "");
  // `regexp_replace(..., '^0', '61')` with no `g` flag replaces the FIRST match
  // only, and `^` can only match at position 0 — so exactly one leading zero is
  // rewritten. JavaScript's non-global `String.replace` behaves identically.
  // `0061...` therefore becomes `61061...`, which is the documented missed
  // match above rather than an oversight.
  const normalised = digits.replace(/^0/, "61");

  return normalised.length >= 1 && normalised.length <= 20 ? normalised : null;
}
