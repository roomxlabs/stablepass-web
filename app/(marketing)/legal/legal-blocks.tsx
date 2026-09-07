import type { LegalBlock } from "@/lib/legal";

import styles from "./legal.module.css";

/**
 * Renders one parsed block of a legal document (ENG-590 / W4).
 *
 * Lifted out of `[slug]/page.tsx` unchanged by ENG-1041, so the dedicated
 * `/legal/delete-account` route renders byte-identical markup to the four
 * documents on the generic route. Two renderers drifting apart is exactly how a
 * compliance page ends up looking like a different site from the privacy policy
 * beside it in the same footer column.
 */
export default function Block({ block }: { block: LegalBlock }) {
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
