// GET /api/notifications — the member's own notification inbox. ENG-957.
//
// Newest first, INBOX_PAGE_SIZE per page, cursored on `created_at` so the
// load-more cannot skip or repeat a row when a new alert arrives mid-scroll
// (an offset would shift under exactly that).
import { ok, UNAUTH, GATED, fail } from "@/lib/api/envelope";
import { supabaseServer } from "@/lib/supabase/server";
import { ACCESS_COLUMNS, hasAccess, type AccessRow } from "@/lib/api/access";
import {
  INBOX_PAGE_SIZE,
  NOTIFICATION_SELECT,
  toInbox,
  type NotificationRow,
} from "./contract";

export async function GET(req: Request) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return UNAUTH();

  // Guardrail #3 — the inbox sits behind the same gate as the content it opens
  // into, matching mobile (the Alerts tab lives inside the gated tab group).
  const { data: sub } = await sb
    .from("subscription").select(ACCESS_COLUMNS).eq("user_id", user.id).maybeSingle();
  if (!hasAccess(sub as AccessRow | null)) return GATED();

  const before = new URL(req.url).searchParams.get("before");
  if (before !== null && Number.isNaN(Date.parse(before))) {
    return fail("validation_failed", "before must be an ISO timestamp", 400);
  }

  let query = sb
    .from("notification")
    // Explicit allow-list, never `*` (guardrail #2). `user_id` is not selected.
    .select(NOTIFICATION_SELECT)
    // OWN ROWS ONLY — on top of RLS, not instead of it.
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    // One extra row is the has-more probe: asking for 51 and returning 50 avoids
    // a second count query just to decide whether to render "Load more".
    .limit(INBOX_PAGE_SIZE + 1);

  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) {
    // Never discard the Supabase error: an undeployed column (42703) lands in
    // the same branch as "no notifications" and would otherwise be a silent,
    // invisible blackout (.rx/gotchas.md).
    console.error("notifications list failed", error);
    return fail("read_failed", "Could not load notifications.", 500);
  }

  const rows = (data ?? []) as unknown as NotificationRow[];
  const hasMore = rows.length > INBOX_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, INBOX_PAGE_SIZE) : rows;

  return ok(page.map(toInbox), { hasMore });
}
