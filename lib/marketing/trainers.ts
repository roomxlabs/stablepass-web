/**
 * Marketing trainers — the live source behind `sections/trainers.data.ts`.
 *
 * The marketing home historically rendered the hardcoded `TRAINERS` array. This
 * reads the same shape from the backend instead, so the strip reflects whatever
 * the stable admins have toggled "Show on marketing site" (ENG-766) without a
 * redeploy.
 *
 * Data source: the `public_trainer` view — the SINGLE anon-readable surface the
 * backend exposes for the marketing space (ENG-765). It is a deliberately narrow
 * subset: a trainer is a name, a location, a bio, and a marketing photo. It never
 * carries owner or contact detail (Guardrail #2), so nothing here can leak PII.
 * The view's `horses` field is intentionally NOT mapped — the marketing cards
 * show trainer info only.
 *
 * The read uses the public anon key against a PUBLIC view; there is no user
 * context and no cookies, so it does not go through `lib/supabase/server.ts`
 * (which binds RLS to the signed-in member). On any error it returns `[]` and the
 * caller falls back to the static list, so a backend hiccup never blanks the page.
 */
import { createClient } from "@supabase/supabase-js";

import type { Trainer } from "@/app/(marketing)/sections/trainers.data";

/** Columns of `public_trainer` we actually render. `horses` is deliberately omitted. */
type PublicTrainerRow = {
  name: string;
  display_name: string | null;
  location: string | null;
  bio: string | null;
  marketing_photo_path: string | null;
};

/**
 * Two-letter fallback disc from a stable name: first letter of the first word and
 * first letter of the last word, skipping an ampersand joiner. Matches how the
 * signed-off static cards were lettered ("Annabel & Rob Archibald" -> "AA",
 * "Corey & Kylie Geran" -> "CG", "Rob Heathcote" -> "RH").
 */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((w) => w && w !== "&");
  if (words.length === 0) return "";
  const first = words[0][0] ?? "";
  const last = words[words.length - 1][0] ?? "";
  return (first + last).toUpperCase();
}

/**
 * Build the public URL for a trainer's marketing photo. The admin copies the
 * approved photo into the PUBLIC `marketing-photos` bucket and stores its object
 * path (e.g. `trainers/<id>.jpg`) on the view. A missing path yields "" so the
 * card falls back to its initials disc.
 */
function photoUrl(baseUrl: string, path: string | null): string {
  if (!path) return "";
  return `${baseUrl}/storage/v1/object/public/marketing-photos/${path}`;
}

function mapRow(baseUrl: string, row: PublicTrainerRow): Trainer {
  const name = (row.display_name ?? row.name ?? "").trim();
  return {
    name,
    location: (row.location ?? "").trim(),
    bio: row.bio?.trim() || undefined,
    photo: photoUrl(baseUrl, row.marketing_photo_path),
    initials: initialsOf(name),
  };
}

/**
 * Fetch the marketing-visible trainers, mapped to the `Trainer` shape the strip
 * renders. Returns `[]` on any failure (missing env, network, query error) so the
 * caller can fall back to the static list rather than surface an error.
 */
export async function getMarketingTrainers(): Promise<Trainer[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return [];

  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from("public_trainer")
      .select("name,display_name,location,bio,marketing_photo_path")
      .order("display_name", { ascending: true });

    if (error || !data) return [];
    return (data as PublicTrainerRow[]).map((row) => mapRow(url, row)).filter((t) => t.name.length > 0);
  } catch {
    return [];
  }
}
