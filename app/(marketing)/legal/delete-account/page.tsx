import type { Metadata } from "next";

import { legalCanonicalUrl, readLegalDocument } from "@/lib/legal";
import { isAlwaysIndexablePath } from "@/lib/seo";

import { CONTACT_EMAIL, contactMailtoHref } from "../../modals/contact-mailto";
import LegalDocumentShell from "../legal-document";
import styles from "../legal.module.css";

/**
 * `/legal/delete-account` (ENG-1041).
 *
 * The URL pasted into Google Play's Data Safety form. Play requires a publicly
 * reachable page where anyone — including someone who uninstalled the app, or
 * never had it — can request deletion of their account and data. The in-app
 * flow (ENG-951 / ENG-952 / ENG-1017) satisfies Apple's 5.1.1(v) and does NOT
 * satisfy this; the two are separate requirements and this page is the second.
 *
 * WHY ITS OWN ROUTE, rather than a fifth entry in `/legal/[slug]`:
 *
 *   1. It needs a real `mailto:`. The markdown subset in `lib/legal.ts`
 *      deliberately does not interpret inline links, so a document on the
 *      generic route can print an address but cannot offer a working one. The
 *      whole point of this page is that a request can actually be sent.
 *   2. It needs its own `robots`. Every other page in this route group is
 *      `noindex` while `MARKETING_IS_INDEXABLE` is false — see `lib/seo.ts`.
 *      This one is exempt, because the person it exists for finds it by
 *      searching, having already deleted the app.
 *
 * The PROSE still lives in `content/legal/delete-account.md` like every other
 * legal document, and renders through the same `<Block>`. A compliance page has
 * to be rewordable by a non-engineer, and it must not look like a different
 * site from the privacy policy sitting beside it in the footer.
 *
 * REQUIREMENTS THIS PAGE MUST KEEP (both are tested):
 *   - No price, and no route to a purchase. Apple's reader-app positioning
 *     (3.1.3(a)) is decided across everything we publish, and a deletion page
 *     that upsells is the exact shape of the problem. It explains deletion.
 *   - No account lookup, no form, nothing that reveals whether an address has
 *     an account. The page is public and unauthenticated; anything that answers
 *     "does this email have a Stablepass account?" is an enumeration oracle.
 */

/** Static. Nothing here is per-request, and a dynamic legal page defeats the
 *  caching the marketing/member subdomain split exists to protect. */
export const dynamic = "force-static";

const SLUG = "delete-account" as const;
const PATHNAME = "/legal/delete-account";

/** The subject the request arrives under, so one shared inbox can sort them. */
const REQUEST_SUBJECT = "Account deletion request";

export function generateMetadata(): Metadata {
  const document = readLegalDocument(SLUG);
  return {
    title: `${document.title} · stablepass.`,
    description:
      "How to request deletion of your Stablepass account and personal information, what deletion removes, and what is retained.",
    // Canonical is the APEX from both hosts, exactly as the other legal pages.
    alternates: { canonical: legalCanonicalUrl(SLUG) },
    // Overrides the marketing layout's `robots`, which is false while the site
    // shows real trainers beside placeholder biography. Next merges metadata
    // layout -> page per top-level key, so naming `robots` here replaces the
    // inherited value rather than being merged into it. `lib/seo.ts` holds the
    // allowlist this agrees with; middleware.ts and robots.txt read the same one.
    // DERIVED, not hardcoded: this is the third of the three indexing surfaces,
    // and reading the allowlist is what makes that claim structurally true
    // rather than merely test-enforced. Drop the path from ALWAYS_INDEXABLE_PATHS
    // and this page goes back to noindex with it, in one edit.
    //
    // `follow: false` is deliberate and is NOT symmetric with `index`.
    // `Disallow: /` stops a crawler FETCHING the rest of the site; it does not
    // stop it INDEXING a URL it discovered as a link. This page is the one page
    // on the site crawlers are invited into, and it sits inside the shared
    // marketing shell, so its nav and footer link `/start`, `/signin` and the
    // other legal routes. Following those is how a fully-disallowed site starts
    // acquiring URL-only index entries. Nothing about Play's requirement needs
    // link discovery: the page itself must be findable, and that is `index`.
    //
    // NOTE, because the comment above this function is easy to over-read: this
    // surface is host-INDEPENDENT. The page is `force-static`, so one HTML file
    // is served on both hosts and this tag says `index` on app.stablepass.co
    // too. The member space is still noindex there — enforced by the two
    // host-aware surfaces, the `X-Robots-Tag` header and that host's
    // `Disallow: /` — and `test/middleware.test.ts` pins the header. Do not
    // "fix" the apparent disagreement by removing either of those.
    robots: { index: isAlwaysIndexablePath(PATHNAME), follow: false },
  };
}

export default function DeleteAccountPage() {
  const document = readLegalDocument(SLUG);

  return (
    <LegalDocumentShell document={document}>
      {/*
        A plain anchor, and nothing else. No form and no fetch: a form here
        would need somewhere to post, which is out of this ticket's scope, and
        it would create an inbox nobody has agreed to watch — the mockup already
        shipped one fictional "message sent" confirmation and ENG-589 removed
        it. A `mailto:` is owned by the visitor's own mail client from the moment
        it opens, so it cannot claim a delivery that did not happen. It also
        cannot become an enumeration oracle, which a form that validated an
        address inevitably would.
      */}
      <div className={styles.action}>
        <span className={`eyebrow ${styles.actionLabel}`}>Request deletion by email</span>
        <a href={contactMailtoHref(REQUEST_SUBJECT)}>{CONTACT_EMAIL}</a>
        <p className={styles.actionNote}>
          Opens your email app with the subject line filled in. Send it from the address your
          account uses.
        </p>
      </div>
    </LegalDocumentShell>
  );
}
