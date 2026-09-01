"use client";

import { useEffect, useState } from "react";

import { contactMailtoHref } from "./contact-mailto";
import Sheet from "./sheet";

/**
 * `#sheet-faq` — the full FAQ overlay — AND the `[data-sheet]` delegate for the
 * whole marketing group (ENG-589 / W3).
 *
 * The delegate lives here because two of the four trigger kinds are rendered by
 * files this ticket must not touch: `sections/faq.tsx` ("View all") and both
 * "Partner with stablepass." buttons in `sections/for-trainers.tsx`. Both W2
 * files say so in their own headers — they shipped the attributes precisely so
 * W3 could bind a delegate and never reopen them. That is also exactly how the
 * source works: one listener on `document`, matched with `closest()`.
 *
 * Mounted once from the footer, so it is present on every marketing page.
 */

/**
 * The sheet's own thirteen, verbatim from the mockup's `#sheet-faq`.
 *
 * Deliberately NOT shared with `sections/faq.tsx`, which renders a curated
 * seven with slightly different wording (its price answer mentions the trial).
 * That difference is the mockup's, not drift: the section teases and the sheet
 * is the full list, which is what "View all" means.
 */
const FAQS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "What is stablepass.?",
    a: "stablepass. is a monthly racing experience subscription that gives subscribers access to behind-the-scenes content from participating thoroughbred racing stables.",
  },
  {
    q: "Is there an introductory offer?",
    a: "Yes. New subscribers who join on or before 30 November 2026 pay $9 per month for their first 6 months, then $19 per month thereafter. Cancel anytime.",
  },
  { q: "How much does stablepass. cost?", a: "stablepass. subscription is $19 per month." },
  {
    q: "What do subscribers receive?",
    a: "Subscribers receive access to stable updates, photos, videos, horse progress reports, race previews, race follow-ups, and other subscription-only racing content from participating stables.",
  },
  {
    q: "Is stablepass. a syndicate?",
    a: "No. stablepass. is not a syndicate. stablepass. is a content and experience subscription only.",
  },
  { q: "Do subscribers receive shares in a horse?", a: "No. stablepass. does not sell shares in racehorses." },
  {
    q: "Do subscribers receive prize money?",
    a: "No. Subscribers do not receive prize money, financial returns, betting returns, or sale proceeds.",
  },
  {
    q: "Is stablepass. a betting service?",
    a: "No. stablepass. is not a betting service and does not provide betting products.",
  },
  { q: "Can I cancel my subscription?", a: "Yes. Subscribers can cancel their monthly subscription anytime." },
  {
    q: "Which horses can I follow?",
    a: "stablepass. works with participating trainers and stables who nominate selected horses for subscribers to follow. The available horses and stable content may change over time.",
  },
  {
    q: "How often will content be added?",
    a: "Content frequency may vary depending on each horse's racing schedule, training stage, spelling period, and stable activity.",
  },
  {
    q: "Is stablepass. suitable for people new to racing?",
    a: "Yes. stablepass. is designed to be simple, easy to understand, and enjoyable for both racing fans and people new to the sport.",
  },
  {
    q: "Can trainers join stablepass.?",
    a: "Yes. Trainers and stables interested in partnering with stablepass. can contact us through the trainer partnership page.",
  },
];

/**
 * Where the two policy triggers go now that W4 owns the real pages.
 *
 * Hard-coded rather than imported from `lib/legal.ts`: that module reads the
 * document bodies off disk with `node:fs` at build time, and pulling it into a
 * client component would drag `node:fs` into the browser bundle. The footer is
 * a server component and does use the helper.
 */
const LEGAL_PATHS: Record<string, string> = { privacy: "/legal/privacy", terms: "/legal/terms" };

export default function FaqSheet() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;

      /**
       * The source's last delegate branch, ported: the footer's social icons
       * are `<a href="#">` placeholders until real accounts exist, and without
       * this a click jumps to the top of the page and pushes a bare `#` into
       * the URL.
       */
      if (event.target.closest("[data-social]")) {
        event.preventDefault();
        return;
      }

      const trigger = event.target.closest<HTMLElement>("[data-sheet]");
      if (!trigger) return;

      const which = trigger.getAttribute("data-sheet");

      if (which === "faq") {
        event.preventDefault();
        setOpen(true);
        return;
      }

      if (which === "contact") {
        // Straight to the mail client. Nothing is submitted, nothing is
        // confirmed, and the page does not pretend otherwise.
        event.preventDefault();
        window.location.href = contactMailtoHref(trigger.getAttribute("data-subject"));
        return;
      }

      /**
       * The footer's own Privacy/Terms entries are real anchors after this
       * ticket, so they never reach this delegate. This branch keeps the fourth
       * kind of the source's DOM contract working for any other trigger that
       * still carries the attribute.
       */
      const legalPath = which ? LEGAL_PATHS[which] : undefined;
      if (legalPath) {
        event.preventDefault();
        window.location.assign(legalPath);
      }
    };

    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  return (
    <Sheet
      id="sheet-faq"
      className="sheet"
      cardClassName="sheet-card sheet-wide"
      labelledBy="sf-h"
      open={open}
      onClose={() => setOpen(false)}
    >
      <span className="eyebrow">FAQ</span>
      <h3 id="sf-h">Frequently asked questions</h3>
      {/* The inline max-width/margin is the mockup's own, on this element. */}
      <div className="faq" style={{ maxWidth: "none", marginTop: 26 }}>
        {FAQS.map((item) => (
          <details key={item.q}>
            <summary>{item.q}</summary>
            <p className="a">{item.a}</p>
          </details>
        ))}
      </div>
    </Sheet>
  );
}
