// GET /api/notifications/unread-count — the sidebar chip. ENG-957.
//
// A `head: true` count, so the rows themselves never cross the wire for what is
// only a number. Deliberately NOT derived from the inbox page: the count must
// not be capped by a page limit, or a member with 60 unread alerts is told 50.
//
// NOT subscription-gated, unlike the list route next door, and that asymmetry is
// deliberate. This returns a COUNT OF THE MEMBER'S OWN ROWS and no content — it
// leaks nothing a lapsed member should not know about their own account. It is
// also chrome on every member screen, so 402-ing it would make the sidebar
// error on each render for exactly the members already being shown the
// reactivate wall. The gate belongs on the content, and the content is the list
// (402) and the horse profile the rows open into.
import { ok, UNAUTH, fail } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";

export async function GET() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { count, error } = await sb
    .from("notification")
    .select("id", { count: "exact", head: true })
    // OWN ROWS ONLY — on top of RLS.
    .eq("user_id", user.id)
    .eq("read", false);

  if (error) {
    console.error("notifications unread-count failed", error);
    return fail("read_failed", "Could not read your unread count.", 500);
  }
  return ok({ unread: count ?? 0 });
}
