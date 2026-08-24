/**
 * The `Trainer` shape the trainer strip renders (ENG-588 / W2, made LIVE by
 * ENG-730 / W4).
 *
 * THIS FILE USED TO BE THE SEAM, AND THE SEAM HAS NOW BEEN USED. It carried
 * nineteen hardcoded placeholder stables ported from the signed-off mockup, plus
 * a shared placeholder bio and horse line, and its own doc comment promised the
 * swap would be a one-file change: "replace `TRAINERS` with a fetch that returns
 * `Trainer[]` and nothing else moves". That is exactly what ENG-730 did. The
 * data is gone; the TYPE stays here so `trainers-strip.tsx`, `trainer-carousel.tsx`
 * and `modals/trainer-modal.tsx` keep importing from the same place they always
 * did, and so the route group still contains no data source of its own.
 *
 * The roster now comes from `lib/marketing/trainers.ts`, which reads the
 * anon-visible `public_trainer` view (ENG-765 / W7). It lives OUTSIDE this route
 * group on purpose — see that file's header — because two guards ban Supabase
 * from `app/(marketing)/**` and this change honours them rather than exempting
 * itself from them.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GUARDRAIL #2 (no owner PII), RESTATED FOR LIVE DATA — this is the important
 * part now that the fields are no longer hand-written.
 *
 * A public trainer is name, location, photograph, bio and horse names. `bio` and
 * `horses` are NEW here and they come from the marketing-safe view ONLY: the
 * view's fixed column list is the boundary, it filters to trainers an admin has
 * explicitly opted in (`marketing_visible`, default FALSE), and it exposes
 * nothing from `trainer_contact` at all. Do NOT widen this type with contact
 * details, owner names, the private `photo_url`, `website_url`, or anything else
 * a future column might tempt you with — a field added here is a field rendered
 * on an anonymous public page.
 */

export type Trainer = {
  /**
   * The view's `trainer.id`. Used ONLY as a React key and NEVER rendered.
   *
   * The strip keyed on `name` while the list was a hand-curated nineteen. With
   * an admin-driven roster two stables can share a name, and duplicate React
   * keys silently drop cards, so the key has to be the identifier.
   */
  id: string;
  /** `display_name` when the stable set one, otherwise `name`. */
  name: string;
  /** Town + state, spelled out. MAY be "" — the card then omits the line. */
  location: string;
  /**
   * Public `marketing-photos` bucket URL, unsigned.
   *
   * NULL is the COMMON case, not an edge case: `marketing_photo_path` stays null
   * until an admin copies a photo across (ENG-766 / W8), so at launch most cards
   * render the mockup's `.tr-init` initials disc instead of a photograph.
   */
  photo: string | null;
  /** Two-letter disc shown when there is no photograph (or one fails to load). */
  initials: string;
  /** The stable's own words. MAY be "" — the card then omits the paragraph. */
  bio: string;
  /** Comma-separated active horse names, capped at 12 by the view. MAY be "". */
  horses: string;
};
