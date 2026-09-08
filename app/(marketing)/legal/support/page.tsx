import type { Metadata } from "next";

import { legalCanonicalUrl, readLegalDocument } from "@/lib/legal";
import { isAlwaysIndexablePath } from "@/lib/seo";

import { CONTACT_EMAIL, contactMailtoHref } from "../../modals/contact-mailto";
import LegalDocumentShell from "../legal-document";
import styles from "../legal.module.css";

/**
 * `/legal/support` — the Support URL on the App Store and Google Play listings.
 *
 * Apple requires the Support URL to resolve and to show a person how to get
 * help; a 404 there is a rejection, and until this page existed the only
 * candidate was the marketing home page, which carries the address in its
 * footer and nothing else. That would probably have passed. This is the version
 * that does not depend on "probably".
 *
 * WHY ITS OWN ROUTE, exactly as `/legal/delete-account` (ENG-1041): the page's
 * whole job is that a visitor can actually send a message, and the markdown
 * subset in `lib/legal.ts` deliberately does not interpret inline links, so a
 * document on the generic `/legal/[slug]` route can print the address but not
 * offer a working one. It is in `LEGAL_STANDALONE_SLUGS` and deliberately NOT
 * in `LEGAL_SLUGS` — listing it in both would have two routes claim one path,
 * with the static segment winning and the dynamic prerender left as dead weight
 * nobody could see was dead. `test/legal-routes.test.tsx` pins that separation.
 *
 * The PROSE lives in `content/legal/support.md` like every other legal
 * document, so the wording can be changed by someone who does not write JSX.
 *
 * ROBOTS: inherited, i.e. `noindex` while the marketing site is. Deliberate,
 * and the one place this page differs from delete-account. That page is exempt
 * because the person it exists for finds it by searching, having already
 * removed the app. A support page is reached from the store listing, where
 * Apple links it directly — it does not need to be findable in search, and
 * adding it to `ALWAYS_INDEXABLE_PATHS` would widen the indexing surface of a
 * site that is still in waitlist mode for no benefit.
 */

/** Static. Nothing here is per-request, and a dynamic legal page defeats the
 *  caching the marketing/member subdomain split exists to protect. */
export const dynamic = "force-static";

const SLUG = "support" as const;
const PATHNAME = "/legal/support";

/** The subject the request arrives under, so one shared inbox can sort them. */
const REQUEST_SUBJECT = "Stablepass support";

export function generateMetadata(): Metadata {
  const document = readLegalDocument(SLUG);
  return {
    title: `${document.title} · stablepass.`,
    description:
      "How to get help with Stablepass — signing in, your subscription, deleting your account, and reporting a problem.",
    // Canonical is the APEX from both hosts, exactly as the other legal pages.
    alternates: { canonical: legalCanonicalUrl(SLUG) },
    // Reads the same allowlist the other two indexing surfaces read, rather
    // than hardcoding `false`. The answer today is `false`; deriving it means
    // adding the path to ALWAYS_INDEXABLE_PATHS is the only edit needed if that
    // ever changes, and this page cannot drift from robots.txt and middleware.
    robots: { index: isAlwaysIndexablePath(PATHNAME), follow: false },
  };
}

export default function SupportPage() {
  const document = readLegalDocument(SLUG);

  return (
    <LegalDocumentShell document={document}>
      {/*
        A plain anchor, and nothing else — the same decision as the deletion
        page and for the same reason. A contact FORM would need somewhere to
        post, and would create an inbox nobody has agreed to watch; the mockup
        shipped one fictional "message sent" confirmation and ENG-589 removed
        it. A `mailto:` is owned by the visitor's mail client from the moment it
        opens, so it cannot claim a delivery that did not happen.
      */}
      <div className={styles.action}>
        <span className={`eyebrow ${styles.actionLabel}`}>Email support</span>
        <a href={contactMailtoHref(REQUEST_SUBJECT)}>{CONTACT_EMAIL}</a>
        <p className={styles.actionNote}>
          Opens your email app with the subject line filled in. Send it from the address your
          account uses where you can.
        </p>
      </div>
    </LegalDocumentShell>
  );
}
