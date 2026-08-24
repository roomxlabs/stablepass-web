import { createClient } from "@supabase/supabase-js";
import { unstable_cache } from "next/cache";

import type { Trainer } from "@/app/(marketing)/sections/trainers.data";

/**
 * The marketing site's ONE read of live trainer data (ENG-730 / W4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE LIVES OUTSIDE `app/(marketing)/`
 *
 * Two independent guards ban Supabase from the marketing route group:
 * `test/marketing-shell.test.tsx` ("never touches Supabase from the marketing
 * route group") sweeps every file under `app/(marketing)/**` for `lib/supabase`
 * and `NEXT_PUBLIC_SUPABASE`, and `test/marketing-home.test.tsx` additionally
 * bans a bare `fetch(` anywhere directly under `sections/`.
 *
 * Those guards are NOT worked around here — they are honoured. The read lives in
 * `lib/marketing/`, so the route group still contains no Supabase reference of
 * its own and both sweeps stay green BY CONSTRUCTION rather than by exemption.
 * `test/marketing-trainers.test.tsx` adds the companion guard the ticket asks
 * for: this is the ONLY module the marketing tree can reach that talks to
 * Supabase, and it may select from `public_trainer` and nothing else.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT (ENG-765 / W7, verified against a live PostgREST — see the PR)
 *
 * `public.public_trainer` is a DEFINER-style view (deliberately NOT
 * `security_invoker`) exposing EXACTLY seven columns and filtering to
 * `status = 'active' AND marketing_visible`. `marketing_visible` DEFAULTS TO
 * FALSE, so "no rows" is the normal launch state, not a failure.
 *
 *   id                   — the trainer's uuid. Used ONLY as a React key here and
 *                          never rendered; names are not unique once the roster
 *                          is admin-driven, and keying on a name would collide.
 *   name                 — always present.
 *   display_name         — NULLABLE. Falls back to `name`.
 *   location             — NULLABLE. Falls back to "" (the card drops the line).
 *   bio                  — NEVER null (`coalesce(bio, '')`), but MAY be "".
 *   marketing_photo_path — NULLABLE object path inside the PUBLIC
 *                          `marketing-photos` bucket. Null until an admin copies
 *                          a photo across (ENG-766 / W8), which is why the
 *                          initials disc is the COMMON case at launch, not an
 *                          edge case.
 *   horses               — NEVER null, but MAY be "". Comma-separated names of
 *                          that trainer's active horses, capped at 12 by the view.
 *
 * A BARE ANON CLIENT is mandatory: no cookies, no session, no signing. The photo
 * is served straight off the public bucket URL unsigned. This is the sanctioned
 * exception recorded in the migration — every OTHER bucket in this project stays
 * private and subscription-gated, and nothing here may ever read `trainer` or
 * `trainer_contact` directly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE **DATA** IS CACHED AND NOT THE **ROUTE**
 *
 * The ticket planned `export const revalidate = 300` on the marketing page.
 * That is now a no-op: ENG-729 made `app/(marketing)/page.tsx` read
 * `searchParams` (so the no-JS waitlist redirect `303 -> /?joined=1` can render
 * its confirmation), which opts `/` out of static prerendering into a
 * per-request render — the build output reports `/` as `f`, not `o`. Route-level
 * ISR and a request-varying page are mutually exclusive.
 *
 * So the ROSTER is cached instead, which is the more precise tool anyway: it
 * caches the expensive thing rather than the whole document, and it survives `/`
 * being dynamic for any other reason later. Same 5-minute freshness the ticket
 * specifies.
 */

/** The bucket the admin app copies marketing-approved photos into (ENG-765). */
export const MARKETING_PHOTO_BUCKET = "marketing-photos";

/**
 * Admin edits reach the site within this many seconds, with no redeploy.
 *
 * Overridable with `MARKETING_TRAINERS_REVALIDATE_SECONDS`, and `0` disables the
 * cache entirely. That is not a test backdoor bolted on: the freshness window is
 * genuine deployment config — the gate's client-approval pass wants edits to
 * appear immediately, production wants them batched — and it is also the only way
 * to make an end-to-end test deterministic. The cache is FILE-BACKED under
 * `.next/`, so it outlives a dev-server restart; without this an e2e run that
 * seeds a roster can be served a roster cached by the PREVIOUS run, for up to
 * five minutes, and fail for a reason nothing in the test says.
 */
// `Number("")` is 0, and `0 >= 0` is true — so reading this without the emptiness
// check meant `MARKETING_TRAINERS_REVALIDATE_SECONDS=` (set-but-empty, the normal
// shape of a half-filled .env) SILENTLY DISABLED the cache and put a Supabase
// round trip on every marketing render. Empty means "unset", not "zero".
const rawRevalidate = process.env.MARKETING_TRAINERS_REVALIDATE_SECONDS?.trim();
const configuredRevalidate = rawRevalidate ? Number(rawRevalidate) : Number.NaN;
export const TRAINER_ROSTER_REVALIDATE_SECONDS =
  Number.isFinite(configuredRevalidate) && configuredRevalidate >= 0 ? configuredRevalidate : 300;

/**
 * The projection, as a LITERAL, exported so a test can pin it.
 *
 * This is security surface, and getting it wrong fails QUIETLY. Measured against
 * a live PostgREST: naming a column the view does not expose (say `photo_url`)
 * answers `400 {"code":"42703"}` rather than 500 — and because a failed read
 * degrades to "no strip" by design below, a widened or misspelt projection would
 * surface as an EMPTY STRIP on a healthy site, not as an error anyone would see.
 * `test/marketing-trainers.test.tsx` asserts this string byte for byte.
 */
export const PUBLIC_TRAINER_COLUMNS = "id,name,display_name,location,bio,marketing_photo_path,horses";

/** The view. Never `trainer`, never `trainer_contact`. */
export const PUBLIC_TRAINER_VIEW = "public_trainer";

type PublicTrainerRow = {
  id: string;
  name: string;
  display_name: string | null;
  location: string | null;
  bio: string | null;
  marketing_photo_path: string | null;
  horses: string | null;
};

/**
 * FIRST word + LAST word, which is the rule the mockup's own hand-written discs
 * follow. Read them off the signed-off cards and it is unambiguous:
 *
 *   "Andrew Bobbin"            -> AB
 *   "Annabel & Rob Archibald"  -> AA   (Annabel ... Archibald, NOT "AR")
 *   "Corey & Kylie Geran"      -> CG
 *   "Matt Cumani"              -> MC
 *
 * So it is given-name + family-name, not "the first two words" — a partnership
 * stable would otherwise read as the two given names and lose the surname the
 * disc is meant to identify. Punctuation-only tokens ("&") are dropped first, so
 * they can never become a letter. A single-word name yields one letter rather
 * than a padded or doubled one.
 */
export function initialsOf(name: string): string {
  const words = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);

  if (words.length === 0) return "";

  const first = words[0]!;
  const last = words[words.length - 1]!;
  return (words.length === 1 ? first[0]! : `${first[0]!}${last[0]!}`).toUpperCase();
}

/**
 * A bare anon client: no cookie adapter, no session persistence, no refresh.
 *
 * Deliberately NOT `supabaseServer()` — that binds the request's auth cookies,
 * which is exactly what must not happen on an anonymous marketing origin, and
 * reading cookies would also opt the caller out of caching.
 */
function anonClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function toTrainer(row: PublicTrainerRow, publicUrlFor: (path: string) => string): Trainer {
  const name = row.display_name?.trim() || row.name;

  return {
    id: row.id,
    name,
    location: row.location?.trim() ?? "",
    // Null path is the COMMON case until W8 runs the copy: no <img> is rendered
    // at all and the mockup's `.tr-init` disc, which sits behind the photograph
    // at `inset:0`, becomes what you see. That is the mockup's own mechanism.
    photo: row.marketing_photo_path ? publicUrlFor(row.marketing_photo_path) : null,
    initials: initialsOf(name),
    bio: row.bio?.trim() ?? "",
    horses: row.horses?.trim() ?? "",
  };
}

/**
 * Read the published roster, ALPHABETICALLY BY DISPLAYED NAME. The order is a
 * visible product decision on a public page, not an implementation detail: the
 * view does not order its rows, so without this the strip's sequence would be
 * whatever PostgREST happened to return. Asserted in
 * `test/marketing-trainers.test.tsx` against a deliberately unsorted fixture.
 *
 * NEVER throws: any failure — the view missing
 * because the deploy landed ahead of ENG-765, an unreachable database, missing
 * env — degrades to an empty roster, which the strip renders as "no section".
 * A broken band on the client's marketing site is strictly worse than no band.
 *
 * NOTE the failure is CACHED like any other result, so a one-second database
 * blip costs the trainer band for the whole revalidate window rather than the
 * blip. That is the deliberate trade — it keeps a flapping database from
 * hammering the origin — but it is why the window is configurable.
 *
 * Only the error's NAME is logged, server-side. A message could carry the query
 * or connection detail, and this runs on the anonymous marketing origin.
 */
export async function readPublicTrainers(): Promise<Trainer[]> {
  const supabase = anonClient();
  if (!supabase) {
    console.error("[marketing/trainers] MissingSupabaseEnv");
    return [];
  }

  try {
    const { data, error } = await supabase.from(PUBLIC_TRAINER_VIEW).select(PUBLIC_TRAINER_COLUMNS);

    if (error) {
      // `||`, NOT `??`. Measured against a dev server pointed at a dead port:
      // supabase-js hands back an error whose `code` is an EMPTY STRING, and
      // `??` only falls back on null/undefined — so this logged
      // "[marketing/trainers] " with nothing after it, which tells an operator
      // exactly as much as logging nothing at all. Fall through to the name, and
      // keep a constant as the last resort so the line is never empty.
      console.error(`[marketing/trainers] ${error.code || error.name || "SupabaseError"}`);
      return [];
    }

    const rows = (data ?? []) as PublicTrainerRow[];
    const publicUrlFor = (path: string) =>
      supabase.storage.from(MARKETING_PHOTO_BUCKET).getPublicUrl(path).data.publicUrl;

    return rows
      .map((row) => toTrainer(row, publicUrlFor))
      .sort((a, b) => a.name.localeCompare(b.name, "en-AU"));
  } catch (thrown) {
    console.error(`[marketing/trainers] ${thrown instanceof Error ? thrown.name : "UnknownError"}`);
    return [];
  }
}

/**
 * The cached roster the page renders. `unstable_cache` rather than route-level
 * ISR, for the reason set out at the top of this file.
 */
export const getMarketingTrainers =
  TRAINER_ROSTER_REVALIDATE_SECONDS === 0
    ? readPublicTrainers
    : unstable_cache(readPublicTrainers, ["marketing", "public-trainer-roster"], {
        revalidate: TRAINER_ROSTER_REVALIDATE_SECONDS,
        tags: ["public-trainer-roster"],
      });
