/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */
"use client";

import Sheet from "./sheet";
import {
  TRAINER_BIO_PLACEHOLDER,
  TRAINER_HORSES_PLACEHOLDER,
  type Trainer,
} from "../sections/trainers.data";

/**
 * `#tr-modal` — the trainer click state (ENG-589 / W3).
 *
 * The source reads the clicked card's `data-loc` / `data-horses` / `data-bio`
 * back out of the DOM. Here the carousel owns the array and hands the `Trainer`
 * straight over, so the modal is rendered from data rather than scraped from
 * markup. The card keeps those attributes anyway — they are the mockup's and
 * W2 ported them — but nothing depends on them now.
 *
 * Guardrail #2 (no owner PII): name, location, photograph and the placeholder
 * bio, which is every field `Trainer` has. There is no owner or contact detail
 * in scope to leak.
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
            {/* The source copies the card's name onto the modal image's alt. */}
            <img id="trm-img" src={trainer.photo} alt={trainer.name} />
          </div>
          <div className="trm-body">
            <span className="eyebrow">Participating stable</span>
            <h3 id="trm-name">{trainer.name}</h3>
            <p className="trm-loc" id="trm-loc">
              {trainer.location}
            </p>
            <span className="trm-badge" id="trm-horses">
              {TRAINER_HORSES_PLACEHOLDER}
            </span>
            <p id="trm-bio">{TRAINER_BIO_PLACEHOLDER}</p>
            <p className="trm-note">{TRAINER_MODAL_NOTE}</p>
          </div>
        </>
      )}
    </Sheet>
  );
}
