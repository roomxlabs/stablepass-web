/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */
"use client";

import Sheet from "./sheet";
import { TRAINER_BIO_PLACEHOLDER, type Trainer } from "../sections/trainers.data";

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
            <p id="trm-bio">{trainer.bio ?? TRAINER_BIO_PLACEHOLDER}</p>
            {/*
              The stable's own site (Justin, 1 Sep 2026: the bios carried no
              link). Only ever an absolute http(s) URL — `public_trainer`
              scheme-checks it and the mapper drops whatever it refused — so
              there is no unsafe-href case to guard here. External, hence
              `rel="noopener noreferrer"`.
            */}
            {trainer.website && (
              <p className="trm-site">
                <a href={trainer.website} target="_blank" rel="noopener noreferrer">
                  Visit {trainer.name}
                </a>
              </p>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
