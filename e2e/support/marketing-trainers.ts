import { createClient } from "@supabase/supabase-js";

/**
 * Seeded trainers for the marketing strip's end-to-end specs (ENG-730 / W4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THESE SPECS SEED A DATABASE INSTEAD OF INTERCEPTING A REQUEST
 *
 * The ticket planned to "mock the `public_trainer` REST call in the existing
 * route-interception harness". That cannot work, and it is worth writing down so
 * nobody spends an afternoon rediscovering it: **the read is SERVER-side.** It
 * happens inside the Next process, in a Server Component, before any HTML
 * reaches the browser. `page.route()` intercepts requests the BROWSER makes, so
 * it never sees this one. (There is also no `rest/v1/**` interception harness in
 * this repo — every existing `page.route` call mocks one of this app's own
 * `/api/*` routes.)
 *
 * So these specs follow the repo's actual precedent for "a test that needs real
 * backend state", `e2e/checkout.spec.ts`: talk to the local Supabase with the
 * well-known local service-role key, seed exactly what the test needs, and
 * `test.skip` cleanly when the stack is not there. Nothing here runs against
 * anything but a local `supabase start` project.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CACHE, WHICH WILL BITE YOU IF YOU IGNORE IT
 *
 * The roster is cached for `MARKETING_TRAINERS_REVALIDATE_SECONDS` (300 by
 * default) and that cache is FILE-BACKED under `.next/`, so it survives a dev
 * server restart. `playwright.config.ts` therefore starts the dev server with
 * that variable set to `0`. If you run these specs against a server you started
 * yourself, set it too, or you will be served a roster from a previous run.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY SEEDING IS PURELY ADDITIVE, AND WHY NOTHING IS TORN DOWN
 *
 * `playwright.config.ts` runs `fullyParallel`, so several workers seed at once.
 * The first version of this helper hid EVERY published trainer and then
 * republished its own, and tore them down in `afterAll`. Both halves race: the
 * hide un-publishes this helper's own rows for the instant before it re-adds
 * them, and one worker's teardown deletes the roster another worker's in-flight
 * test is still asserting against. That produced exactly the failure you would
 * expect and the wrong conclusion to draw from it — "run with --workers=1".
 *
 * So seeding is now ADDITIVE and IDEMPOTENT: it only ever unpublishes rows that
 * are NOT its own, and it never tears down. Every worker converges on the same
 * state, in any order, concurrently. The rows are left published afterwards on
 * purpose — they are inert local fixtures, `supabase db reset` clears them, and
 * `clearMarketingTrainers()` is available for a human who wants them gone.
 */

const LOCAL_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const LOCAL_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

/** Slug prefix, so a run only ever touches rows it created. */
const SLUG_PREFIX = "eng730-e2e-";

/** The one object the seed uploads into the public bucket. */
export const SEEDED_PHOTO_PATH = "e2e/seeded.png";

export type SeededTrainer = {
  slug: string;
  name: string;
  location: string;
  bio: string;
  horses: string[];
  /** Null on purpose for most of them — the launch-common, no-photo-yet card. */
  photoPath: string | null;
};

/**
 * The SHAPES that matter, hand-written: only ONE has had a photograph copied
 * across (the rest render the initials disc, which is the launch-common card),
 * and one has neither a bio nor an active horse, so the "no placeholder copy"
 * sweep is not vacuous.
 *
 * {@link SEEDED_TRAINERS} pads these out to nineteen with filler rows. Nineteen
 * is not sentimental about the old hardcoded roster — it is what makes the
 * marquee behave: the duplicate set is only built once the track is wider than
 * the strip by at least a card, and at 1440px a handful of 222px cards is not.
 * Seeding six made the clone and "never shows the same trainer twice" specs fail
 * for a reason that had nothing to do with the code under test.
 */
const SHAPED_TRAINERS: SeededTrainer[] = [
  {
    slug: `${SLUG_PREFIX}griffiths`,
    name: "E2E Robbie Griffiths",
    location: "Cranbourne, Victoria",
    bio: "Third-generation horseman with a stable built on patience and a long view.",
    horses: ["E2E Ardent Lane", "E2E Bellhaven"],
    photoPath: SEEDED_PHOTO_PATH,
  },
  {
    slug: `${SLUG_PREFIX}archibald`,
    name: "E2E Annabel & Rob Archibald",
    location: "Warwick Farm, New South Wales",
    bio: "A hands-on operation that prizes soundness over speed.",
    horses: ["E2E Dunkeld Rose"],
    photoPath: null,
  },
  {
    slug: `${SLUG_PREFIX}freedman`,
    name: "E2E Mitch Freedman",
    location: "Ballarat, Victoria",
    bio: "Patient placement and a long preparation.",
    horses: ["E2E Fairholme"],
    photoPath: null,
  },
  {
    slug: `${SLUG_PREFIX}bruce`,
    name: "E2E Jack Bruce",
    location: "Eagle Farm, Queensland",
    // No bio and no active horses: both lines must be OMITTED, not filled with
    // placeholder copy. This row is the reason the "no placeholder strings"
    // sweep below is not vacuous.
    bio: "",
    horses: [],
    photoPath: null,
  },
  {
    slug: `${SLUG_PREFIX}cumani`,
    name: "E2E Matt Cumani",
    location: "Ballarat, Victoria",
    bio: "A stable that places its horses where they can win.",
    horses: ["E2E Gleneagle"],
    photoPath: null,
  },
  {
    slug: `${SLUG_PREFIX}stokes`,
    name: "E2E Phillip Stokes",
    location: "Pakenham, Victoria",
    bio: "Long preparations and a patient eye on the spring.",
    horses: ["E2E Hollybank"],
    photoPath: null,
  },
];

/**
 * Filler, so the roster is wide enough for the marquee to clone. Fully populated
 * and obviously synthetic — the interesting shapes are in SHAPED_TRAINERS above.
 */
const FILLER_TRAINERS: SeededTrainer[] = Array.from({ length: 13 }, (_, i) => {
  const n = i + 1;
  return {
    slug: `${SLUG_PREFIX}filler-${String(n).padStart(2, "0")}`,
    name: `E2E Filler${String(n).padStart(2, "0")} Stable${String(n).padStart(2, "0")}`,
    location: `Town ${n}, Victoria`,
    bio: `Fixture bio for seeded stable ${n}.`,
    horses: [`E2E Filler Horse ${n}`],
    photoPath: null,
  };
});

/** The nineteen rows a seeded run publishes. */
export const SEEDED_TRAINERS: SeededTrainer[] = [...SHAPED_TRAINERS, ...FILLER_TRAINERS];

/** The one seeded stable that has a photograph; every other card is initials. */
export const SEEDED_TRAINER_WITH_PHOTO = SHAPED_TRAINERS[0]!;
/** The seeded stable with no bio and no active horses — both lines omitted. */
export const SEEDED_TRAINER_SPARSE = SHAPED_TRAINERS[3]!;

/** Copy that must never appear on a card again (ENG-730 deleted both). */
export const RETIRED_PLACEHOLDER_STRINGS = [
  "Horses to be confirmed",
  "Trainer bio to come from the stable.",
];

/**
 * LOOPBACK ONLY. This is the one guard that makes the header's claim true
 * instead of aspirational.
 *
 * Both the URL and the service-role key fall back to local defaults but are
 * OVERRIDABLE from the environment, and unlike every other seeding helper in
 * this repo (which mutate rows keyed to a user they just created) this one
 * BULK-MUTATES rows it did not create — and the column it flips is exactly the
 * one deciding what the client's public marketing site publishes.
 *
 * So a developer with staging or production `NEXT_PUBLIC_SUPABASE_URL` and
 * `SUPABASE_SERVICE_ROLE_KEY` exported who typed `npx playwright test` would
 * unpublish every real trainer and publish nineteen rows called
 * "E2E Filler01 Stable01". Refuse to run anywhere but a loopback host.
 */
/** Log why seeding gave up, then report the failure. */
function reason(why: string): false {
  console.error(`[eng730 seed] ${why}`);
  return false;
}

function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch (thrown) {
    return reason(`threw: ${thrown instanceof Error ? thrown.name : "unknown"}`);
  }
}

function admin() {
  return createClient(LOCAL_SUPABASE_URL, LOCAL_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * Publish {@link SEEDED_TRAINERS}. Returns `false` when the local stack cannot
 * serve them — no Supabase, or a database that predates ENG-765's view — so the
 * caller can `test.skip` instead of failing obscurely.
 *
 * Every `false` path logs WHY first. There are several of them, any one turns
 * off around a dozen trainer specs, and the run then reports "0 failed" — with
 * no CI in this repo, the skip count is the only signal, so the reason had
 * better be on stdout rather than left for someone to bisect.
 */
export async function seedMarketingTrainers(): Promise<boolean> {
  if (!isLoopback(LOCAL_SUPABASE_URL)) {
    console.error(
      `[eng730 seed] refusing to seed a non-loopback database: ${LOCAL_SUPABASE_URL}. ` +
        "This helper bulk-unpublishes trainers and must only ever touch a local supabase start project.",
    );
    return false;
  }

  const supabase = admin();

  try {
    // Does ENG-765's view exist in this database at all?
    const probe = await supabase.from("public_trainer").select("id").limit(1);
    if (probe.error) return reason(`public_trainer is not readable: ${probe.error.code || probe.error.message}`);

    // Unpublish only rows that are NOT ours, so the strip shows this roster and
    // nothing else — while never un-publishing a row a parallel worker is
    // relying on. `not.like` is the whole reason this is parallel-safe.
    const hidden = await supabase
      .from("trainer")
      .update({ marketing_visible: false })
      .not("slug", "like", `${SLUG_PREFIX}%`)
      .eq("marketing_visible", true);
    if (hidden.error) return reason(`could not unpublish non-seeded trainers: ${hidden.error.code}`);

    await ensureSeedPhoto(supabase);

    for (const trainer of SEEDED_TRAINERS) {
      const upserted = await supabase
        .from("trainer")
        .upsert(
          {
            slug: trainer.slug,
            name: trainer.name,
            location: trainer.location,
            bio: trainer.bio,
            status: "active",
            marketing_visible: true,
            marketing_photo_path: trainer.photoPath,
          },
          { onConflict: "slug" },
        )
        .select("id")
        .single();
      if (upserted.error || !upserted.data) return reason(`upsert failed for ${trainer.slug}: ${upserted.error?.code}`);

      const trainerId = upserted.data.id as string;
      for (const horse of trainer.horses) {
        const existing = await supabase
          .from("horse")
          .select("id")
          .eq("trainer_id", trainerId)
          .eq("display_name", horse)
          .maybeSingle();
        if (existing.data) continue;
        const inserted = await supabase
          .from("horse")
          .insert({ trainer_id: trainerId, display_name: horse, racing_name: horse, status: "active" });
        if (inserted.error) return reason(`horse insert failed for ${trainer.slug}: ${inserted.error.code}`);
      }
    }

    // Confirm the view actually publishes them — the WHERE clause is the view's,
    // not ours, and a seed that does not reach the view is a skip, not a pass.
    const published = await supabase.from("public_trainer").select("id");
    if (published.error) return reason(`view unreadable after seeding: ${published.error.code}`);
    const got = published.data?.length ?? 0;
    if (got < SEEDED_TRAINERS.length) return reason(`view published ${got} rows, expected >= ${SEEDED_TRAINERS.length}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The photographed card is only honest if the object really exists in the public
 * bucket — otherwise its `<img>` 404s and the "a photograph actually loads"
 * assertion has to be dropped. So the seed uploads one, unsigned and public,
 * exactly as ENG-766 will.
 *
 * A 1x1 PNG is enough: the assertion is that the URL resolves and the browser
 * decodes it, not what it depicts.
 */
const SEED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function ensureSeedPhoto(supabase: ReturnType<typeof admin>): Promise<void> {
  try {
    const bytes = Buffer.from(SEED_PNG_BASE64, "base64");
    await supabase.storage
      .from("marketing-photos")
      .upload(SEEDED_PHOTO_PATH, bytes, { contentType: "image/png", upsert: true });
  } catch {
    // A missing object only costs the photograph assertion, never the run.
  }
}

/**
 * Unpublish this helper's rows. NOT called by the specs — see the header: a
 * teardown that runs while another worker is mid-test is the race this helper
 * exists to avoid. Kept for a human who wants a clean local database.
 */
export async function clearMarketingTrainers(): Promise<void> {
  if (!isLoopback(LOCAL_SUPABASE_URL)) return;
  try {
    await admin().from("trainer").update({ marketing_visible: false }).like("slug", `${SLUG_PREFIX}%`);
  } catch {
    /* the stack is gone; nothing to clean up */
  }
}
