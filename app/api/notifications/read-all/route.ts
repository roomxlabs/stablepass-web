// POST /api/notifications/read-all — clear the member's own unread alerts. ENG-957.
import { noContent, UNAUTH, fail } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";

export async function POST() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  const { error } = await sb
    .from("notification")
    .update({ read: true })
    // OWN ROWS ONLY. On an UNFILTERED update this is not defence in depth, it is
    // the entire filter — without it this route is "mark the whole table read".
    .eq("user_id", user.id)
    // Narrows the write to the rows that actually change, so a full inbox is not
    // rewritten on every press. Mirrors mobile's `markAllRead`.
    .eq("read", false);

  if (error) {
    console.error("notifications mark-all-read failed", error);
    return fail("write_failed", "Could not mark your alerts read.", 500);
  }
  return noContent();
}
