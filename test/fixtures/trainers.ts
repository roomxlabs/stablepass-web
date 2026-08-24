import type { Trainer } from "@/app/(marketing)/sections/trainers.data";

/**
 * The trainer roster the marketing tests render (ENG-730 / W4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS AT ALL
 *
 * Until ENG-730 the strip rendered nineteen hardcoded stables from
 * `sections/trainers.data.ts`, and the suites asserted against that array
 * directly — `expect(cards).toHaveLength(19)`, first card "Andrew Bobbin",
 * `data-trainer-count="19"`. Those assertions were sound while the data was in
 * the repo. They cannot survive live data, and the honest replacement is NOT to
 * delete them: it is to move them onto a fixture the test owns, so the rendering
 * contract stays pinned exactly as hard as before while the CONTENT stops being
 * the repo's business.
 *
 * So: everything about how a roster becomes cards is still asserted to the card.
 * What is no longer asserted is WHICH trainers exist — that is now the database's
 * answer, and asserting it here would only pin a fixture to itself.
 *
 * THREE ROWS, CHOSEN TO COVER THE THREE SHAPES THE LIVE VIEW ACTUALLY RETURNS:
 *
 *   1. Fully populated — photo, location, bio, horses. The "after W8 has run"
 *      card, and the only one that renders an `<img>`.
 *   2. NULL PHOTO — the COMMON case at launch, not an edge case:
 *      `marketing_photo_path` stays null until an admin copies a photo into the
 *      public bucket (ENG-766 / W8), so this is what most cards look like on day
 *      one. Renders the initials disc and no `<img>` at all.
 *   3. Sparse — null photo AND empty location, bio and horses. `bio` and
 *      `horses` are `coalesce`d to "" by the view rather than null, and a trainer
 *      with no active horses genuinely returns "". Every optional element is
 *      omitted rather than rendered blank.
 */
export const TRAINER_FIXTURE: Trainer[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Andrea Beaumont",
    location: "Cranbourne, Victoria",
    photo: "https://stub.supabase.test/storage/v1/object/public/marketing-photos/beaumont.jpg",
    initials: "AB",
    bio: "Third-generation horseman with a stable built on patience and a long view.",
    horses: "Ardent Lane, Bellhaven, Corryong Gold",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Cormac Dwyer",
    location: "Warwick Farm, New South Wales",
    photo: null,
    initials: "CD",
    bio: "A hands-on operation that prizes soundness over speed.",
    horses: "Dunkeld Rose",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Elspeth Finn",
    location: "",
    photo: null,
    initials: "EF",
    bio: "",
    horses: "",
  },
];

/** The one card that carries a photograph, for the `<img>` assertions. */
export const TRAINER_WITH_PHOTO = TRAINER_FIXTURE[0]!;
/** The launch-shaped card: visible, published, but no photo copied across yet. */
export const TRAINER_WITHOUT_PHOTO = TRAINER_FIXTURE[1]!;
/** Everything optional absent — the omit-don't-render-empty case. */
export const TRAINER_SPARSE = TRAINER_FIXTURE[2]!;

/**
 * Copy that must never appear on the page again. ENG-730 deleted both constants
 * from `trainers.data.ts`; these strings are kept HERE, in a test-only file, so
 * a suite can assert their absence without the shipped bundle carrying them.
 */
export const RETIRED_PLACEHOLDER_STRINGS = [
  "Horses to be confirmed",
  "Trainer bio to come from the stable. The full profile will cover the story of the stable, the team behind the horses, and the horses nominated for stablepass. subscribers to follow.",
];
