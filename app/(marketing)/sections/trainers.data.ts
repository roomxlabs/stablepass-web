/**
 * The nineteen participating stables (ENG-588 / W2).
 *
 * Ported verbatim from the signed-off mockup's `#stable-trainers` cards, in the
 * mockup's own order. Names, locations and photographs are the real supplied
 * trainer details; the bio and the horse line are placeholders the mockup carries
 * on every card.
 *
 * THIS FILE IS THE SEAM. The list becomes admin-driven in the CMS epic, and the
 * whole point of the shape below is that the swap is a one-file change: replace
 * `TRAINERS` with a fetch that returns `Trainer[]` and nothing else moves.
 * `trainers-strip.tsx` is purely presentational and takes `trainers` as a prop,
 * so it never learns where the data came from.
 *
 * Guardrail #2 (no owner PII): a trainer is name + location + photograph only.
 * Do not widen this type with contact details, owner names, or anything from
 * `trainer_contact` — that data is admin-only and must never reach a public page.
 */

export type Trainer = {
  /** Display name, exactly as the stable supplied it. */
  name: string;
  /** Town + state, spelled out (the mockup never abbreviates the state). */
  location: string;
  /** Extracted asset under public/marketing/, never an inlined data URI. */
  photo: string;
  /** Two-letter fallback disc, shown when the photograph fails to load. */
  initials: string;
};

/**
 * Every card in v2.6/v2.7 carries the identical placeholder bio, so it lives here
 * once instead of nineteen times. It is the copy the client signed off; the real
 * bios arrive from the stables with the admin CMS.
 */
export const TRAINER_BIO_PLACEHOLDER =
  "Trainer bio to come from the stable. The full profile will cover the story of the stable, the team behind the horses, and the horses nominated for stablepass. subscribers to follow.";

/** Same story: the horse line is a placeholder on all nineteen cards. */
export const TRAINER_HORSES_PLACEHOLDER = "Horses to be confirmed";

export const TRAINERS: Trainer[] = [
  { name: "Andrew Bobbin", location: "Stawell, Victoria", photo: "/marketing/990b2787.jpg", initials: "AB" },
  {
    name: "Annabel & Rob Archibald",
    location: "Warwick Farm, New South Wales",
    photo: "/marketing/3e4a5059.jpg",
    initials: "AA",
  },
  { name: "Archie Alexander", location: "Ballarat, Victoria", photo: "/marketing/18df1298.jpg", initials: "AA" },
  {
    name: "Corey & Kylie Geran",
    location: "Toowoomba, Queensland",
    photo: "/marketing/1915f688.jpg",
    initials: "CG",
  },
  { name: "Danny Williams", location: "Goulburn, New South Wales", photo: "/marketing/b3ef1083.jpg", initials: "DW" },
  { name: "Jack Bruce", location: "Eagle Farm, Queensland", photo: "/marketing/d5b44861.jpg", initials: "JB" },
  { name: "Jason Warren", location: "Mornington, Victoria", photo: "/marketing/769aca9c.jpg", initials: "JW" },
  { name: "Jimmy Downes", location: "Beaudesert, Queensland", photo: "/marketing/0660c8a4.jpg", initials: "JD" },
  { name: "Liam Birchley", location: "Sunshine Coast, Queensland", photo: "/marketing/a8e18374.jpg", initials: "LB" },
  {
    name: "Marc Chevalier",
    location: "Hawkesbury, New South Wales",
    photo: "/marketing/20c2765e.jpg",
    initials: "MC",
  },
  { name: "Matt Hoysted", location: "Eagle Farm, Queensland", photo: "/marketing/bea4d294.jpg", initials: "MH" },
  { name: "Mitch Freedman", location: "Ballarat, Victoria", photo: "/marketing/36035a12.jpg", initials: "MF" },
  { name: "Phillip Stokes", location: "Pakenham, Victoria", photo: "/marketing/633cd55c.jpg", initials: "PS" },
  { name: "Rob Heathcote", location: "Eagle Farm, Queensland", photo: "/marketing/5cb95e93.jpg", initials: "RH" },
  { name: "Robbie Griffiths", location: "Cranbourne, Victoria", photo: "/marketing/24639b61.jpg", initials: "RG" },
  { name: "Scott Singleton", location: "Scone, New South Wales", photo: "/marketing/87d29a43.jpg", initials: "SS" },
  { name: "Shane Nichols", location: "Mornington, Victoria", photo: "/marketing/739bbb9a.jpg", initials: "SN" },
  { name: "Chris Munce", location: "Eagle Farm, Queensland", photo: "/marketing/cc058213.jpg", initials: "CM" },
  { name: "Matt Cumani", location: "Ballarat, Victoria", photo: "/marketing/343b9735.jpg", initials: "MC" },
];
