import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enrichFeedSubjects, type PostSubjectRow } from "@/lib/feed/subject";

// `signPhotoMap` is Storage — mocked out so this file tests the IDENTITY reads
// only, never a Storage call (matches the module's own read budget comment).
vi.mock("@/lib/storage/photos", () => ({
  signPhotoMap: vi.fn(async () => new Map<string, string>()),
  HORSE_PHOTO_BUCKET: "horse-photos",
  TRAINER_PHOTO_BUCKET: "trainer-photos",
}));

type RecordedCall = { select: string; column: string; values: readonly unknown[] };
type ReadError = { code?: string; message?: string };

/**
 * A fake `sb` that RECORDS every `.from(table).select(cols).in(col, values)`
 * call it receives, per table, and answers with the fixture rows for that
 * table. This is the whole point of the file: `enrichFeedSubjects` must never
 * let a null or undefined id reach `.in()`, and the only way to prove that is
 * to record the EXACT arguments the call received, not merely that a query ran.
 *
 * `horseError`/`trainerError` (ENG-1270) let a fixture make either read
 * resolve REJECTED — `{ data: null, error }`, the exact PostgREST shape a
 * schema-drift 42703 or an RLS change hands back — so the error path gets the
 * same call-recording rigour as the happy path.
 */
function fakeSb(fixtures: { horse?: unknown[]; trainer?: unknown[]; horseError?: ReadError; trainerError?: ReadError }) {
  const calls: { horse: RecordedCall[]; trainer: RecordedCall[] } = { horse: [], trainer: [] };
  const from = vi.fn((table: string) => ({
    select: (cols: string) => ({
      in: (column: string, values: readonly unknown[]) => {
        const call: RecordedCall = { select: cols, column, values };
        if (table === "horse") calls.horse.push(call);
        if (table === "trainer") calls.trainer.push(call);
        if (table === "horse" && fixtures.horseError) {
          return Promise.resolve({ data: null, error: fixtures.horseError });
        }
        if (table === "trainer" && fixtures.trainerError) {
          return Promise.resolve({ data: null, error: fixtures.trainerError });
        }
        const data = table === "horse" ? (fixtures.horse ?? []) : table === "trainer" ? (fixtures.trainer ?? []) : [];
        return Promise.resolve({ data, error: null });
      },
    }),
  }));
  const sb = { from } as unknown as SupabaseClient;
  return { sb, calls, from };
}

describe("enrichFeedSubjects — the read budget (at most one horse read, one trainer read)", () => {
  it("a mixed page (horse + trainer + stablepass) makes EXACTLY one horse read (non-null horse ids only) and one trainer read (trainer-subject source_trainer_ids only)", async () => {
    const rows: PostSubjectRow[] = [
      { id: "p-horse", subject: "horse", horse_id: "h1", source_trainer_id: null, byline: null },
      { id: "p-trainer", subject: "trainer", horse_id: null, source_trainer_id: "t1", byline: null },
      { id: "p-stablepass", subject: "stablepass", horse_id: null, source_trainer_id: null, byline: "Racing TV" },
    ];
    const { sb, calls } = fakeSb({
      horse: [{ id: "h1", display_name: "Mahogany", photo_url: null, trainer: null }],
      trainer: [{ id: "t1", name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill", photo_url: null }],
    });

    await enrichFeedSubjects(sb, rows);

    expect(calls.horse).toHaveLength(1);
    expect(calls.trainer).toHaveLength(1);
    // NO null, and no undefined, ever reaches `.in()` — this is the point of
    // this test. The horse read carries ONLY the non-null horse id; the
    // trainer read carries ONLY the trainer-subject row's source_trainer_id.
    expect(calls.horse[0].values).toEqual(["h1"]);
    expect(calls.trainer[0].values).toEqual(["t1"]);
  });

  it("an all-StablePass page makes ZERO horse reads and ZERO trainer reads", async () => {
    const rows: PostSubjectRow[] = [
      { id: "p1", subject: "stablepass", horse_id: null, source_trainer_id: null, byline: "Racing TV" },
      { id: "p2", subject: "stablepass", horse_id: null, source_trainer_id: null, byline: "Sky Racing" },
    ];
    const { sb, calls } = fakeSb({});

    await enrichFeedSubjects(sb, rows);

    expect(calls.horse).toEqual([]);
    expect(calls.trainer).toEqual([]);
  });

  it("a page of horse rows only makes one horse read and zero trainer reads", async () => {
    const rows: PostSubjectRow[] = [
      { id: "p1", subject: "horse", horse_id: "h1", source_trainer_id: null, byline: null },
      { id: "p2", subject: "horse", horse_id: "h2", source_trainer_id: null, byline: null },
    ];
    const { sb, calls } = fakeSb({
      horse: [
        { id: "h1", display_name: "Mahogany", photo_url: null, trainer: null },
        { id: "h2", display_name: "Winx", photo_url: null, trainer: null },
      ],
    });

    await enrichFeedSubjects(sb, rows);

    expect(calls.horse).toHaveLength(1);
    expect(calls.horse[0].values).toEqual(["h1", "h2"]);
    expect(calls.trainer).toEqual([]);
  });

  // A drifted row is one where `horse_id` and `subject` disagree — e.g. a
  // trainer-subject row that still carries a stale `horse_id` from before it
  // was re-subjected. Relying on B1's `post_subject_shape` CHECK (another
  // repo) to have nulled it would put this module's own stated invariant
  // somewhere it cannot pin. Both branches narrow by SUBJECT first, so a
  // drifted row reads as the subject it DECLARES, and its stale id never
  // reaches a read at all.
  it("a DRIFTED trainer-subject row carrying a stale horse_id never lets that id reach the horse read", async () => {
    const rows: PostSubjectRow[] = [
      { id: "p-horse", subject: "horse", horse_id: "h1", source_trainer_id: null, byline: null },
      { id: "p-t", subject: "trainer", horse_id: "h-stale", source_trainer_id: "t1", byline: null },
    ];
    const { sb, calls } = fakeSb({
      horse: [{ id: "h1", display_name: "Mahogany", photo_url: null, trainer: null }],
      trainer: [{ id: "t1", name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill", photo_url: null }],
    });

    await enrichFeedSubjects(sb, rows);

    expect(calls.horse[0].values).toEqual(["h1"]);
  });
});

describe("enrichFeedSubjects — the read error (this is the failure the module exists to end)", () => {
  // The whole reason `error` exists: a rejected identity read is INVISIBLE at
  // the card — every horse head still resolves (to "Unknown horse") and every
  // byline blanks, with no crash and no empty state to give it away. This test
  // is named so it is obvious that ending exactly that silent failure is why
  // this module returns an error at all, not a bare map.
  it("a rejected horse read blanks every byline with no crash: error is non-null (code/message round-trip) and identityById is still populated for every row id", async () => {
    const rows: PostSubjectRow[] = [
      { id: "p-horse", subject: "horse", horse_id: "h1", source_trainer_id: null, byline: null },
      { id: "p-trainer", subject: "trainer", horse_id: null, source_trainer_id: "t1", byline: null },
    ];
    const horseError = { code: "42703", message: "column post.subject does not exist" };
    const { sb } = fakeSb({
      trainer: [{ id: "t1", name: "Chris Waller", stable_name: null, location: null, photo_url: null }],
      horseError,
    });

    const { identityById, error } = await enrichFeedSubjects(sb, rows);

    expect(error).toEqual(horseError);
    // Identities are still built for every row — a caller that decides a
    // degraded page beats no page can use them, even though nothing in this
    // repo does that today (the three screens branch on `error` and stop).
    expect(identityById.get("p-horse")).toBeDefined();
    expect(identityById.get("p-trainer")).toBeDefined();
  });

  it("a rejected trainer read also surfaces a non-null error (code/message round-trip)", async () => {
    const rows: PostSubjectRow[] = [{ id: "p1", subject: "trainer", horse_id: null, source_trainer_id: "t1", byline: null }];
    const trainerError = { code: "42703", message: "column post.subject does not exist" };
    const { sb } = fakeSb({ trainerError });

    const { identityById, error } = await enrichFeedSubjects(sb, rows);

    expect(error).toEqual(trainerError);
    expect(identityById.get("p1")).toBeDefined();
  });

  it("a clean mixed page (both reads succeed) resolves error: null", async () => {
    const rows: PostSubjectRow[] = [
      { id: "p-horse", subject: "horse", horse_id: "h1", source_trainer_id: null, byline: null },
      { id: "p-trainer", subject: "trainer", horse_id: null, source_trainer_id: "t1", byline: null },
    ];
    const { sb } = fakeSb({
      horse: [{ id: "h1", display_name: "Mahogany", photo_url: null, trainer: null }],
      trainer: [{ id: "t1", name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill", photo_url: null }],
    });

    const { error } = await enrichFeedSubjects(sb, rows);

    expect(error).toBeNull();
  });

  it("an all-StablePass page makes NO identity read at all — a skipped read is not an error", async () => {
    const rows: PostSubjectRow[] = [
      { id: "p1", subject: "stablepass", horse_id: null, source_trainer_id: null, byline: "Racing TV" },
    ];
    const { sb, calls } = fakeSb({});

    const { error } = await enrichFeedSubjects(sb, rows);

    expect(calls.horse).toEqual([]);
    expect(calls.trainer).toEqual([]);
    expect(error).toBeNull();
  });
});

describe("enrichFeedSubjects — the resolved head per subject", () => {
  it("builds the horse head: name from the horse, line2 from the trainer, no link", async () => {
    const rows: PostSubjectRow[] = [{ id: "p1", subject: "horse", horse_id: "h1", source_trainer_id: null, byline: null }];
    const { sb } = fakeSb({
      horse: [
        {
          id: "h1",
          display_name: "Mahogany",
          photo_url: null,
          trainer: { id: "t1", name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill", photo_url: null },
        },
      ],
    });

    const { identityById } = await enrichFeedSubjects(sb, rows);

    expect(identityById.get("p1")!.head).toEqual({
      kind: "horse",
      name: "Mahogany",
      line2: "Chris Waller",
      avatarUrl: null,
      href: null,
    });
  });

  it("builds the trainer head: name and href from the trainer, line2 = stable · location", async () => {
    const rows: PostSubjectRow[] = [{ id: "p1", subject: "trainer", horse_id: null, source_trainer_id: "t1", byline: null }];
    const { sb } = fakeSb({
      trainer: [{ id: "t1", name: "Chris Waller", stable_name: "Waller Racing", location: "Rosehill", photo_url: null }],
    });

    const { identityById } = await enrichFeedSubjects(sb, rows);

    expect(identityById.get("p1")!.head).toEqual({
      kind: "trainer",
      name: "Chris Waller",
      line2: "Waller Racing · Rosehill",
      avatarUrl: null,
      href: "/trainers/t1",
    });
  });

  it("builds the stablepass head: the lowercase literal, the editorial byline, no link", async () => {
    const rows: PostSubjectRow[] = [{ id: "p1", subject: "stablepass", horse_id: null, source_trainer_id: null, byline: "Racing TV" }];
    const { sb } = fakeSb({});

    const { identityById } = await enrichFeedSubjects(sb, rows);

    expect(identityById.get("p1")!.head).toEqual({
      kind: "stablepass",
      name: "stablepass",
      line2: "Racing TV",
      avatarUrl: null,
      href: null,
    });
  });

  it("a trainer-subject row whose trainer is RLS-hidden (missing) falls back to a name-only, non-linking head without throwing", async () => {
    const rows: PostSubjectRow[] = [{ id: "p1", subject: "trainer", horse_id: null, source_trainer_id: "t-hidden", byline: null }];
    const { sb, calls } = fakeSb({ trainer: [] });

    // Does not throw — the assignment below would reject the test if it did.
    const { identityById } = await enrichFeedSubjects(sb, rows);

    // The read still ran (and asked for the hidden id) — it simply came back empty.
    expect(calls.trainer[0].values).toEqual(["t-hidden"]);
    expect(identityById.get("p1")!.head).toEqual({
      kind: "trainer",
      name: "Trainer",
      line2: null,
      avatarUrl: null,
      href: null,
    });
  });

  // The SAME name-"Trainer"/no-link/no-line2 head as the RLS-hidden case above,
  // reached the other way in: `source_trainer_id` itself is null, so there is
  // no id to even ask for. This must make NO trainer read at all — an empty
  // `.in()` list is a real, wasted round trip on the exact page this module
  // exists to make cheap.
  it("a trainer-subject row with source_trainer_id null makes NO trainer read, and resolves the name-'Trainer' head", async () => {
    const rows: PostSubjectRow[] = [{ id: "p1", subject: "trainer", horse_id: null, source_trainer_id: null, byline: null }];
    const { sb, calls } = fakeSb({});

    const { identityById } = await enrichFeedSubjects(sb, rows);

    expect(calls.trainer).toEqual([]);
    expect(identityById.get("p1")!.head).toEqual({
      kind: "trainer",
      name: "Trainer",
      line2: null,
      avatarUrl: null,
      href: null,
    });
  });

  it("a null subject (legacy row) is treated as horse", async () => {
    const rows: PostSubjectRow[] = [{ id: "p1", subject: null, horse_id: "h1", source_trainer_id: null, byline: null }];
    const { sb } = fakeSb({
      horse: [{ id: "h1", display_name: "Mahogany", photo_url: null, trainer: null }],
    });

    const { identityById } = await enrichFeedSubjects(sb, rows);

    expect(identityById.get("p1")!.subject).toBe("horse");
    expect(identityById.get("p1")!.head!.kind).toBe("horse");
  });
});
