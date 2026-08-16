import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import {
  formatLastUpdated,
  isLegalDocumentSlug,
  LEGAL_SLUGS,
  legalCanonicalUrl,
  readLegalDocument,
  redirectTargetFor,
  type LegalBlock,
} from "@/lib/legal";

import styles from "../legal.module.css";

/**
 * `/legal/[slug]` (ENG-590 / W4).
 *
 * Fixes a live defect: `app/start/trial-start-form.tsx` has always linked
 * `/legal/terms` and `/legal/privacy` from the signup form and both 404, because
 * no `/legal` route existed anywhere in the repo. Wix was going to own these
 * pages; it no longer does. The App Store submission also needs a reachable
 * privacy URL, which is why mobile's `SUPPORT_LINKS.privacy` is still null.
 *
 * The route sits in the (marketing) group, so it inherits the nav, the footer
 * and the scoped stylesheet W1 ported — a page deep-linked from an app-store
 * listing lands on the marketing shell, signed out, with no member chrome and
 * no auth. Nothing here touches Supabase or any dynamic API.
 *
 * That the signup form's links are RELATIVE is the whole trick: these routes
 * serve from both hosts, so `/legal/terms` resolves on app.stablepass.co too and
 * `trial-start-form.tsx` (owned by ENG-571, in flight) needs no edit at all.
 */

/**
 * All four slugs are prerendered and nothing else is routable.
 *
 * `dynamicParams = false` is doing real work here, on both halves of the ticket.
 * It makes `/legal/nonsense` a genuine 404 served by the router — not a redirect,
 * and not a rendered page that calls `notFound()`. And it is what keeps the four
 * real routes fully static: with dynamic params on, Next has to keep a
 * server-rendered path alive for the unknown-slug case, and a legal page that
 * renders per-request defeats the caching the subdomain split exists to protect.
 */
export const dynamicParams = false;

export function generateStaticParams(): { slug: string }[] {
  return LEGAL_SLUGS.map((slug) => ({ slug }));
}

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;

  // A redirect slug never renders, so it has no metadata worth building.
  if (!isLegalDocumentSlug(slug)) return {};

  const document = readLegalDocument(slug);
  return {
    title: `${document.title} · stablepass.`,
    description: `${document.title} for stablepass., the thoroughbred racing experience and entertainment subscription.`,
    // Canonical is the APEX from both hosts. The pages deliberately render on
    // stablepass.co and app.stablepass.co alike, and Apple, Stripe and search
    // each need one URL to treat as the document's home.
    alternates: { canonical: legalCanonicalUrl(slug) },
  };
}

function Block({ block }: { block: LegalBlock }) {
  switch (block.kind) {
    case "heading":
      return block.level === 2 ? (
        <h2 className={styles.section}>{block.text}</h2>
      ) : (
        <h3 className={styles.subsection}>{block.text}</h3>
      );
    case "list":
      return (
        <ul className={styles.list}>
          {block.items.map((item, index) => (
            // Index, not the text: two identical bullets are legal copy, not a bug.
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    case "paragraph":
      return <p className={styles.body}>{block.text}</p>;
  }
}

export default async function LegalPage({ params }: PageProps) {
  const { slug } = await params;

  // `/legal/cancellation` and `/legal/acceptable-use` -> 308 to the terms.
  // There is no distinct copy for either in existence, and this ticket does not
  // write legal text. `permanentRedirect` (308), not `redirect` (307): the pair
  // are permanent aliases, not a temporary detour, and a 308 is what lets a
  // crawler or an app-store reviewer collapse them onto the terms page.
  const redirectTarget = redirectTargetFor(slug);
  if (redirectTarget) permanentRedirect(redirectTarget);

  // Unreachable while dynamicParams is false — kept so the slug is narrowed for
  // the read below, and so the route still 404s rather than throwing if that
  // export is ever removed.
  if (!isLegalDocumentSlug(slug)) notFound();

  const document = readLegalDocument(slug);

  return (
    <main className={styles.page}>
      <div className="wrap">
        <article className={styles.doc}>
          <span className={`eyebrow ${styles.kicker}`}>Legal</span>
          <h1 className={styles.title}>{document.title}</h1>
          <p className={styles.updated}>Last updated {formatLastUpdated(document.lastUpdated)}</p>
          {document.blocks.map((block, index) => (
            <Block key={`${block.kind}-${index}`} block={block} />
          ))}
        </article>
      </div>
    </main>
  );
}
