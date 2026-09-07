// PATCH /api/notifications/:id — mark ONE of the member's own alerts read. ENG-957.
import { noContent, UNAUTH, fail } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  // Only `read: true` is accepted. The inbox has no un-read affordance on either
  // platform, and taking the flag from the body would let a client write `false`
  // back onto a row the server considers delivered.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_failed", "read: true required", 400);
  }
  if (!body || typeof body !== "object" || (body as { read?: unknown }).read !== true) {
    return fail("validation_failed", "read: true required", 400);
  }

  // `notification.id` is a uuid. A malformed id is rejected HERE rather than
  // handed to Postgres, which would raise 22P02 and surface as a 500 — three
  // problems at once: it contradicts this route's documented status set
  // (204 · 400 · 401), it costs a round-trip to learn the id was never valid,
  // and it hands back an ORACLE. The whole point of answering 204 on a miss
  // (see below) is that a caller cannot tell "not yours" from "does not exist";
  // a 500 for malformed ids reintroduces exactly that distinction.
  if (!UUID_RE.test(id)) return fail("validation_failed", "id must be a uuid", 400);

  const { error } = await sb
    .from("notification")
    .update({ read: true })
    .eq("id", id)
    // OWN ROWS ONLY — this is NOT redundant with `.eq('id', …)`. An id-only
    // PATCH is a write that would happily flip another member's row the moment
    // RLS is relaxed or bypassed; the pair is what makes the self-scoping a
    // property of this code rather than a property of the database's mood.
    // Mobile's `markRead` carries the identical pair for the identical reason.
    .eq("user_id", user.id);

  if (error) {
    console.error("notification mark-read failed", error);
    return fail("write_failed", "Could not mark that alert read.", 500);
  }

  // 204 whether or not a row matched. A miss means the row is not the viewer's
  // (or no longer exists) and the correct answer is silence, not a 404 that
  // would confirm the id exists for somebody else.
  return noContent();
}
