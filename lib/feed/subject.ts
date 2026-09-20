import type { SupabaseClient } from "@supabase/supabase-js";
import { signPhotoMap, HORSE_PHOTO_BUCKET, TRAINER_PHOTO_BUCKET } from "@/lib/storage/photos";
import { displayHorseNameOrEmpty } from "@/lib/format/horse-name";
import type { FeedPost, PostHeadModel, PostSubject } from "@/components/types";

/**
 * subject — the ONE place a feed page's rows become card IDENTITY (ENG-1270).
 *
 * WHY THIS EXISTS. Before B1 (ENG-1264) every post had a horse, so three
 * screens each hand-rolled the same lookup: read `horse` by `horse_id`, reach
 * the trainer through the horse's embed, sign both photos, map the byline. B1
 * makes `horse_id` NULLABLE — a trainer post has no horse and a StablePass post
 * has neither — and a null inside `.in("id", horseIds)` does not fail loudly:
 * PostgREST rejects the WHOLE query, the screens destructure only `data`, and
 * the page renders with EVERY byline blank. One horse-less post would take out
 * the identity of every other card on the page.
 *
 * So the lookup moves here, once, with the null filter as the first thing it
 * does — and `test/feed-subject.test.ts` asserts the exact recorded `.in()`
 * arguments with `toEqual`, because a filter that is merely "probably fine" is
 * the failure mode this module was written to end.
 *
 * READ BUDGET. At most TWO reads per page, never per card: one `horse` read for
 * the non-null horse ids, one `trainer` read for the trainer-subject rows'
 * `source_trainer_id`. Either list being empty SKIPS its read entirely — an
 * all-StablePass page makes no identity read at all, and `.in()` is never called
 * with an empty list.
 *
 * WHAT IT DOES NOT DO. It does not gate. Every caller has already passed the
 * 402 content gate (guardrail 3) before it has rows to enrich, and this module
 * reads `horse` / `trainer` under the VIEWER's own RLS session — it can never be
 * the thing that lifts a read above the gate.
 */

/** The subject-bearing columns of a `post` row, as every feed projection carries them. */
export type PostSubjectRow = {
  id: string;
  subject?: string | null;
  horse_id?: string | null;
  source_trainer_id?: string | null;
  byline?: string | null;
};

const SUBJECTS: readonly string[] = ["horse", "trainer", "stablepass"];

/**
 * The row's subject, defensively. Anything unrecognised — null (a pre-B1 row),
 * a projection that forgot the column, a value from a newer be than this client
 * — reads as `horse`, which is the card every such row has always rendered.
 * ONE place decides this so "absent" cannot mean two things in two screens.
 */
export function postSubjectOf(row: Pick<PostSubjectRow, "subject">): PostSubject {
  const s = row.subject;
  return typeof s === "string" && SUBJECTS.includes(s) ? (s as PostSubject) : "horse";
}

/** The `horse` embed every feed screen reads — identity only, and there is no owner field. */
type TrainerRef = {
  id: string;
  name: string;
  stable_name: string | null;
  location: string | null;
  photo_url: string | null;
};
type HorseRef = {
  id: string;
  display_name: string;
  photo_url: string | null;
  trainer: TrainerRef | TrainerRef[] | null;
};

/**
 * The exact `horse` projection. Pinned as a constant for the ENG-794 reason:
 * `sb` is untyped, so `tsc` can never catch a too-narrow `.select()` — dropping
 * a column here silently blanks the byline, the stable-update panel footer or
 * the Follow pill with no type error.
 */
export const SUBJECT_HORSE_COLUMNS =
  "id, display_name, photo_url, trainer:trainer_id(id, name, stable_name, location, photo_url)";

/**
 * The trainer read for TRAINER-subject rows. It is a separate read and not an
 * embed because there is no horse to embed it on — that is the whole point of
 * the subject column.
 */
export const SUBJECT_TRAINER_COLUMNS = "id, name, stable_name, location, photo_url";

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

/** `stable_name · location`, either half optional; null when the trainer has neither. */
export function stableLineOf(t: { stable_name?: string | null; location?: string | null } | null): string | null {
  if (!t) return null;
  const line = [t.stable_name, t.location].filter(Boolean).join(" · ");
  return line || null;
}

/**
 * The identity half of a `FeedPost` — everything the head needs plus the fields
 * the rest of the card still reads (the Follow pill's `trainerId`, the
 * stable-update panel's `stableName`/`stableLocation`). A caller spreads it:
 *
 *     { ...postIntrinsics(r, intrinsics), ...identity, bookmarked }
 */
export type PostSubjectIdentity = Pick<
  FeedPost,
  | "subject"
  | "horseId"
  | "horseName"
  | "trainerName"
  | "trainerId"
  | "stableName"
  | "stableLocation"
  | "horsePhotoUrl"
  | "trainerPhotoUrl"
  | "byline"
  | "head"
>;

/**
 * Build the head for ONE post from identity that is already resolved.
 *
 * Pure, and exported on its own because two consumers have their identity
 * without this module's batch read: `trainer-posts.tsx` takes the trainer from
 * page props and the horse from the route's own embed, and `resolvePostHead`
 * below rebuilds a horse head for a screen that never enriched at all.
 */
export function buildPostHead(input: {
  subject: PostSubject;
  horseName?: string | null;
  horsePhotoUrl?: string | null;
  trainerId?: string | null;
  trainerName?: string | null;
  stableName?: string | null;
  stableLocation?: string | null;
  trainerPhotoUrl?: string | null;
  byline?: string | null;
}): PostHeadModel {
  if (input.subject === "stablepass") {
    return {
      kind: "stablepass",
      // The literal, lowercase, and NOT the wordmark asset — this is the voice
      // of the publisher in the same 17px name slot every other card uses
      // (client decision, 19 Sep 2026).
      name: "stablepass",
      // The editorial source. Null is not expected (the be's shape CHECK makes
      // `byline` NOT NULL for this subject) but renders as a bare posted-ago
      // rather than an orphan separator.
      line2: input.byline ?? null,
      // The S-mark is a local static asset drawn by `PostHead`, so there is
      // nothing to sign and nothing to carry.
      avatarUrl: null,
      // NOT A LINK, deliberately: there is no StablePass profile to land on.
      href: null,
    };
  }
  if (input.subject === "trainer") {
    // A missing or RLS-hidden trainer falls back to the generic name with NO
    // link — a head that navigates to a trainer the viewer cannot see would be
    // a 404 dressed as an affordance.
    const id = input.trainerId ?? null;
    const name = input.trainerName ?? null;
    return {
      kind: "trainer",
      name: name || "Trainer",
      line2: stableLineOf({ stable_name: input.stableName, location: input.stableLocation }),
      avatarUrl: input.trainerPhotoUrl ?? null,
      href: id && name ? `/trainers/${id}` : null,
    };
  }
  return {
    kind: "horse",
    name: input.horseName || "Unknown horse",
    line2: input.trainerName ?? null,
    avatarUrl: input.horsePhotoUrl ?? null,
    // The horse head has never been a link and this ticket does not make it one.
    href: null,
  };
}

/**
 * The head a component should draw for a post: the enriched one when the screen
 * resolved it, otherwise the horse head rebuilt from the fields every screen has
 * always carried. This is what lets `horse-posts.tsx` stay untouched and a
 * pre-B1 row keep its old card.
 */
export function resolvePostHead(post: FeedPost): PostHeadModel {
  if (post.head) return post.head;
  return buildPostHead({
    subject: post.subject ?? "horse",
    horseName: post.horseName,
    horsePhotoUrl: post.horsePhotoUrl,
    trainerName: post.trainerName,
    trainerId: post.trainerId,
    stableName: post.stableName,
    stableLocation: post.stableLocation,
    trainerPhotoUrl: post.trainerPhotoUrl,
    byline: post.byline,
  });
}

/** Whatever PostgREST handed back on a failed identity read. `sb` is untyped, so this is structural. */
export type FeedSubjectReadError = { message?: string; code?: string } & Record<string, unknown>;

/**
 * What `enrichFeedSubjects` returns.
 *
 * `error` is NOT decoration. The whole module exists because a failed identity
 * read is INVISIBLE at the card — every horse head reads "Unknown horse" and
 * every byline blanks, with no crash and no empty state to give it away. A
 * caller MUST branch on it; the three member screens raise their existing error
 * state and stop.
 */
export type FeedSubjectEnrichment = {
  identityById: ReadonlyMap<string, PostSubjectIdentity>;
  /** Non-null when the `horse` or `trainer` read was rejected. `null` on a clean page AND on a page that made no read at all. */
  error: FeedSubjectReadError | null;
};

/**
 * Read one feed page's identity: at most one `horse` read and one `trainer`
 * read, then ONE signing batch per bucket, then a head per post.
 *
 * `sb` is the caller's own client (`supabaseBrowser` in the client islands that
 * use this), so every read and every signature runs as the VIEWER.
 */
export async function enrichFeedSubjects(
  sb: SupabaseClient,
  rows: readonly PostSubjectRow[],
): Promise<FeedSubjectEnrichment> {
  // THE NULL FILTER. First, and before anything is deduped — a single null
  // reaching `.in()` rejects the whole query and blanks every byline on the
  // page. `test/feed-subject.test.ts` asserts the recorded arguments exactly.
  // The other way into that same blanked page — the read being REJECTED for a
  // reason of its own — is handled below, at `readError`.
  // Both branches narrow by SUBJECT first and only then by null. Relying on
  // B1's `post_subject_shape` CHECK to have nulled `horse_id` on a trainer or
  // StablePass row would put this module's stated invariant in another repo; the
  // symmetry is the point — a drifted row reads as the subject it declares.
  const horseIds = [
    ...new Set(
      rows
        .filter((r) => postSubjectOf(r) === "horse")
        .map((r) => r.horse_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const trainerIds = [
    ...new Set(
      rows
        .filter((r) => postSubjectOf(r) === "trainer")
        .map((r) => r.source_trainer_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  // An empty list SKIPS the read. `.in("id", [])` is a real query that returns
  // nothing — paying a round trip for an answer we already have, on the exact
  // page (all-StablePass) this ticket exists to make cheap.
  const [horseResult, trainerResult] = await Promise.all([
    horseIds.length
      ? sb.from("horse").select(SUBJECT_HORSE_COLUMNS).in("id", horseIds)
      : Promise.resolve({ data: null, error: null }),
    trainerIds.length
      ? sb.from("trainer").select(SUBJECT_TRAINER_COLUMNS).in("id", trainerIds)
      : Promise.resolve({ data: null, error: null }),
  ]);

  // THE ERROR PATH, and it is the SAME failure this module exists to end.
  // Dropping `error` here would reproduce the null bug exactly: a rejected
  // `horse` read (an RLS change, a 42703 after schema drift, a transport blip)
  // returns `data: null`, every card falls back to "Unknown horse" with a green
  // suite, and the page looks CALM while every byline on it is wrong. So the
  // error is carried out to the caller, which already owns an error state, and
  // the screens stop rather than paint a plausible lie. The identities below are
  // still built — a caller that decides a degraded page beats no page can use
  // them — but nothing in this repo does that today.
  const readError = (horseResult?.error ?? trainerResult?.error ?? null) as FeedSubjectReadError | null;

  const horseRows = (horseResult?.data ?? []) as HorseRef[];
  const trainerRows = (trainerResult?.data ?? []) as TrainerRef[];

  // `photo_url` is a bare path in a PRIVATE bucket — sign it or the avatar
  // renders as a broken RELATIVE url (lib/storage/photos.ts). ONE batch per
  // bucket for the whole page, never per card (ENG-958). The trainer batch
  // covers BOTH sources of a trainer photo — the horse embed and the standalone
  // trainer read — in a single call.
  const [horsePhotos, trainerPhotos] = await Promise.all([
    signPhotoMap(
      sb,
      HORSE_PHOTO_BUCKET,
      horseRows.map((h) => h.photo_url),
    ),
    signPhotoMap(sb, TRAINER_PHOTO_BUCKET, [
      ...horseRows.map((h) => one(h.trainer)?.photo_url),
      ...trainerRows.map((t) => t.photo_url),
    ]),
  ]);

  const horseById = new Map(horseRows.map((h) => [h.id, h]));
  const trainerById = new Map(trainerRows.map((t) => [t.id, t]));

  const out = new Map<string, PostSubjectIdentity>();
  for (const row of rows) {
    const subject = postSubjectOf(row);
    const horse = row.horse_id ? horseById.get(row.horse_id) ?? null : null;
    // A trainer-subject row has no horse to reach the trainer through, so the
    // standalone read is the ONLY source; a horse-subject row keeps the embed.
    const trainer = subject === "trainer" ? (row.source_trainer_id ? trainerById.get(row.source_trainer_id) ?? null : null) : one(horse?.trainer ?? null);

    const horseName = displayHorseNameOrEmpty(horse?.display_name) || (subject === "horse" ? "Unknown horse" : "");
    const horsePhotoUrl = horse?.photo_url ? horsePhotos.get(horse.photo_url) ?? null : null;
    const trainerPhotoUrl = trainer?.photo_url ? trainerPhotos.get(trainer.photo_url) ?? null : null;
    // On a horse card the trainer name is the byline's green lead and has always
    // fallen back to the product name when the embed came back empty. That
    // fallback is horse-only: a trainer card whose trainer is hidden says
    // "Trainer" (see `buildPostHead`), and a StablePass card never has one.
    const trainerName = trainer?.name ?? (subject === "horse" ? "Stablepass" : "");
    const identity = {
      subject,
      horseId: row.horse_id ?? null,
      horseName,
      trainerName,
      trainerId: trainer?.id ?? null,
      stableName: trainer?.stable_name ?? null,
      stableLocation: trainer?.location ?? null,
      horsePhotoUrl,
      trainerPhotoUrl,
      byline: row.byline ?? null,
    };
    out.set(row.id, { ...identity, head: buildPostHead({ ...identity, subject }) });
  }
  return { identityById: out, error: readError };
}
