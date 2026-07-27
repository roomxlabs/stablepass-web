// POST /api/trainers/:id/website-click — logs one first-party click on a trainer's
// Website link (A2, ENG-274). Every click is its own row: no dedupe, no upsert.
//
// GUARDRAIL: the row's `user_id` comes from the SESSION (auth.getUser()), never
// from the request body — the client cannot attribute a click to another member.
// The insert goes through the caller's RLS client (supabaseServer), so the
// backend policy `user_id = auth.uid()` is the real boundary; this is defence in
// depth, not the boundary itself.
//
// Trainer existence is NOT pre-checked: the FK on trainer_id rejects a bogus id,
// which also keeps this route enumeration-resistant (no "does this trainer exist"
// oracle). Only the id's *shape* is validated, so a malformed id fails fast as a
// 400 rather than surfacing a Postgres uuid cast error.
import { noContent, fail, UNAUTH } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  if (!UUID_RE.test(id)) return fail("bad_request", "Invalid trainer id.", 400);

  const { error } = await sb
    .from("trainer_website_click")
    .insert({ trainer_id: id, user_id: user.id });

  // 204 regardless of the insert's outcome: this is analytics, and a failed log
  // must never read as a failed user action. But we do NOT discard the error —
  // silently writing zero rows is exactly the failure that hides for months.
  // Two known 204-but-no-row cases, both intentional:
  //   * unknown trainer id -> FK violation (keeps the route enumeration-safe);
  //   * lapsed member -> the RLS policy is
  //     `user_id = auth.uid() AND has_content_access(auth.uid())`, so clicks are
  //     only logged for entitled members. Unreachable through the UI (the profile
  //     page itself gates lapsed members to the reactivate prompt, so the link is
  //     never rendered for them) — recorded here because the contract is silent.
  if (error) console.error("trainer_website_click insert failed", error);

  return noContent();
}
