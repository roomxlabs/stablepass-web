// Shared password locator for the Playwright suite (ENG-1062).
//
// Every sign-in helper in e2e/ used to reach for `page.getByLabel("Password")`.
// That broke the whole signed-in half of the suite the day
// `components/password-input.tsx` (7cc153e, 1 Sep 2026) gave the sign-in and
// trial-start forms a reveal toggle: the toggle renders as
// `<button aria-label="Show password">`, and `getByLabel` matches an accessible
// name by SUBSTRING, so "Password" started resolving to two nodes. Every such
// helper then died with
//
//   strict mode violation: getByLabel('Password') resolved to 2 elements
//
// at the LOGIN step, before the test under review ever ran — 68 of 169 tests
// across 27 spec files, reported as failures of whatever screen the spec was
// about (ENG-1058 found it, ENG-1062 fixed it).
//
// The product is not the bug: an accessible reveal toggle needs an accessible
// name, and it keeps it. The TEST locator is what has to be precise. So sign-in
// goes through here and targets the field by its id, which no aria-label can
// ever collide with — `#password` is the password input on /signin, /start and
// /reset-password alike.
//
// And because the last regression was silent, `fillPassword` asserts the
// locator resolved to exactly ONE node before it types. If a future change
// makes it ambiguous again, the suite says so in one loud, specific line
// instead of going dark.
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The password INPUT itself (never the reveal toggle beside it).
 *
 * `#password` is the id used by the sign-in form (`app/signin/sign-in-form.tsx`),
 * the trial-start form (`app/start/trial-start-form.tsx`) and the "New password"
 * field of the reset form (`app/reset-password/reset-password-form.tsx`).
 */
export function passwordField(page: Page): Locator {
  return page.locator("#password");
}

/**
 * Type into the password field, failing loudly if the locator is no longer
 * unique. Prefer this over any label-based query — see the note at the top.
 */
export async function fillPassword(page: Page, value: string): Promise<void> {
  const field = passwordField(page);
  await expect(
    field,
    "the e2e password locator must resolve to exactly ONE node. It did not, so " +
      "`#password` is no longer unique on this page. Narrow the locator — do not " +
      "relax this check, and do not weaken the form's accessibility to satisfy it.",
  ).toHaveCount(1);
  await field.fill(value);
}
