/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */
"use client";

import Sheet from "./sheet";
import { type Trainer } from "../sections/trainers.data";

/**
 * `#tr-modal` — the trainer click state (ENG-589 / W3).
 *
 * The source reads the clicked card's `data-loc` / `data-horses` / `data-bio`
 * back out of the DOM. Here the carousel owns the array and hands the `Trainer`
 * straight over, so the modal is rendered from data rather than scraped from
 * markup. The card keeps those attributes anyway — they are the mockup's and
 * W2 ported them — but nothing depends on them now.
 *
 * Guardrail #2 (no owner PII): name, location, photograph, bio and horse names,
 * which is every field `Trainer` has. There is no owner or contact detail in
 * scope to leak — ENG-730's live roster comes from the marketing-safe
 * `public_trainer` view, whose fixed column list is the boundary.
 *
 * ENG-730: bio and the horse line were module-level placeholder constants,
 * identical on all nineteen cards. They are now the stable's real words, and
 * any of them can be absent — each is omitted rather than rendered empty, and no
 * placeholder copy is substituted.
 */

/**
 * Kept VERBATIM from v2.6 at the ticket's instruction. It describes a trainer
 * page that does not exist in this epic, but it is client-signed-off copy and
 * the real page arrives with the admin-CMS epic. Not ours to reword.
 */
export const TRAINER_MODAL_NOTE =
  "On the live site this opens the trainer's own page, where you can see every horse they have nominated and follow the stable.";

export type TrainerModalProps = {
  /** `null` closes it. */
  trainer: Trainer | null;
  onClose: () => void;
};

export default function TrainerModal({ trainer, onClose }: TrainerModalProps) {
  return (
    <Sheet
      id="tr-modal"
      className="tr-modal"
      cardClassName="trm-card"
      labelledBy="trm-name"
      open={trainer !== null}
      onClose={onClose}
    >
      {trainer && (
        <>
          <div className="trm-photo">
            {/*
              `.trm-photo` is a solid brand-green panel behind the photograph, so
              with no photo it would be an empty block of colour. The card's own
              initials disc is reused here instead — `.tr-init` is `inset:0` and
              is not scoped to `.tr-card`, so this needs NO new CSS rule, which
              matters because marketing.css is W3's file and is diffed
              rule-for-rule against the mockup.
            */}
            {trainer.photo ? (
              // The source copies the card's name onto the modal image's alt.
              <img id="trm-img" src={trainer.photo} alt={trainer.name} />
            ) : (
              <span className="tr-init">{trainer.initials}</span>
            )}
          </div>
          <div className="trm-body">
            <span className="eyebrow">Participating stable</span>
            <h3 id="trm-name">{trainer.name}</h3>
            {trainer.location && (
              <p className="trm-loc" id="trm-loc">
                {trainer.location}
              </p>
            )}
            {trainer.horses && (
              <span className="trm-badge" id="trm-horses">
                {trainer.horses}
              </span>
            )}
            {trainer.bio && <p id="trm-bio">{trainer.bio}</p>}
            <p className="trm-note">{TRAINER_MODAL_NOTE}</p>
          </div>
        </>
      )}
    </Sheet>
  );
}
