/**
 * The contact path (ENG-589 / W3, decision 6).
 *
 * v2.6 renders a contact FORM whose submit handler calls `preventDefault()` and
 * adds a CSS class that swaps in a confirmation of delivery, with nothing behind
 * it. That is a mockup affordance, and shipping it would be a fictional
 * integration: the page would claim to have delivered a message it never sent.
 * Removing it is the point of this half of the ticket, so there is no form, no
 * fetch, no third-party form service and no success state anywhere — just a
 * `mailto:` the visitor's own mail client owns from the moment it opens.
 *
 * (The confirmation's wording is deliberately not quoted anywhere in this file,
 * not even to describe it. A guardrail test greps the built output — bundles AND
 * sourcemaps — and requires it absent; a comment reciting it would fail that
 * test, correctly, because the grep cannot tell prose from markup.)
 *
 * The subject comes from the trigger's `data-subject`, which is what makes one
 * mailbox serve three buttons.
 */

/**
 * The only mailbox anywhere in this project confirmed to receive mail.
 *
 * ENG-593 (the DNS cutover) lists preserving the MX for this address in its
 * scope, and "a test email to it arrives" as an acceptance criterion, which
 * makes it a live mailbox on the client's current zone.
 *
 * Two alternatives were rejected:
 *
 *   - The `hello@`/`support@`/`trainers@` addresses the v2/v2.1/v3 concepts
 *     linked, which were on the OTHER top-level domain of the same name — the
 *     one owned by an unrelated third party that W5 also had to route the
 *     canonical URL away from. Those mailtos would send a subscriber's enquiry
 *     to a stranger. (Not written out here: a guardrail test greps shipped
 *     source for that domain.)
 *   - `support@` and `trainers@` on the real apex, which would read better
 *     against two of the three subjects but which no document anywhere says
 *     exist. An invented alias bounces, and a bounce is worse than a shared
 *     inbox.
 *
 * CONFIRMED 17 Aug 2026: use Justin's own address. If per-subject aliases are
 * created later, this becomes a three-entry map and nothing else changes.
 */
export const CONTACT_EMAIL = "justin@stablepass.co";

/**
 * Build the `mailto:` for a trigger's `data-subject`.
 *
 * Absent or blank subject yields a bare `mailto:` rather than an empty
 * `?subject=`, so the visitor gets a clean compose window instead of one with a
 * blank subject line pre-filled.
 */
export function contactMailtoHref(subject?: string | null): string {
  const trimmed = subject?.trim();
  return trimmed ? `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(trimmed)}` : `mailto:${CONTACT_EMAIL}`;
}
