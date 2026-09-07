import { formatLastUpdated, type LegalDocument } from "@/lib/legal";

import Block from "./legal-blocks";
import styles from "./legal.module.css";

/**
 * The whole visual shell of a legal page — not just its blocks (ENG-1041).
 *
 * ENG-1041 first lifted only the `<Block>` renderer out of `[slug]/page.tsx`,
 * and a reviewer correctly pointed out that this did not achieve what it
 * claimed: the surrounding scaffold — the `<main>`/`.wrap`/`<article>` frame,
 * the "Legal" kicker, the `<h1>`, the "Last updated" line — was still written
 * out twice, and THAT is the part that drifts. A heading margin changed on one
 * route and not the other would leave the deletion page looking like a
 * different site from the privacy policy sitting beside it in the same footer
 * column, which is exactly the outcome the lift was supposed to prevent.
 *
 * `children` is the one seam: the generic `/legal/[slug]` route passes none,
 * and `/legal/delete-account` passes its request action. Everything above the
 * seam is shared by construction rather than by discipline.
 */
export default function LegalDocumentShell({
  document,
  children,
}: {
  document: LegalDocument;
  children?: React.ReactNode;
}) {
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
          {children}
        </article>
      </div>
    </main>
  );
}
