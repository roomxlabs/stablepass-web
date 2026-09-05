// The notification inbox contract — shared by the BFF routes in this folder and
// the /notifications screen. ENG-957.
//
// SOURCE OF TRUTH: stablepass-mobile `lib/notifications.ts` (ENG-215 / ENG-872).
// This is the web port of that module's contract, deliberately kept in the same
// shape so the two platforms cannot drift on what an alert MEANS. Where web
// differs it is because web has fewer screens, and that difference is called out
// on `ROUTED_SCREENS` below.
//
// GUARDRAILS VISIBLE HERE (.rx/guardrails.md):
//  - #2 NO OWNER PII: the column allow-list below is explicit and never
//    `select('*')`. `user_id` is deliberately NOT selected — it is already the
//    viewer's, and returning it hands the browser an id it has no use for.
//  - Self-scoping: every read and every write in this folder carries
//    `.eq('user_id', user.id)` ON TOP of RLS. Not redundant — see the note on
//    the PATCH route: `.eq('id', …)` alone is a write that would happily flip
//    another member's row if RLS were ever relaxed.

/**
 * `notification`, minus `user_id` (already the viewer's) and `pushed`
 * (server-side dispatch bookkeeping — the browser has no use for it).
 * Mirrors mobile's `NOTIFICATION_COLUMNS` exactly.
 */
export const NOTIFICATION_COLUMNS = [
  "id",
  "type",
  "target_type",
  "target_id",
  "title",
  "body",
  "read",
  "created_at",
] as const;

/** The projection string for a Supabase `.select()`. Never `*`. */
export const NOTIFICATION_SELECT = NOTIFICATION_COLUMNS.join(",");

/**
 * One inbox page. The ticket specifies 50 with a load-more, and this matches
 * mobile's `INBOX_LIMIT` — an unbounded inbox read is not acceptable on either
 * platform.
 */
export const INBOX_PAGE_SIZE = 50;

/** `notification.type` — the CHECK constraint in docs/specs/database.sql §7. */
export type NotificationType = "new_post" | "race_day" | "race_result" | "milestone";

/** `notification.target_type` — what `target_id` addresses. */
export type NotificationTargetType = "race" | "post" | "horse";

export type NotificationRow = {
  id: string;
  type: string;
  target_type: string;
  target_id: string;
  title: string | null;
  body: string | null;
  read: boolean | null;
  created_at: string | null;
};

/** One row as the screen consumes it. */
export type InboxNotification = {
  id: string;
  type: NotificationType;
  targetType: NotificationTargetType;
  targetId: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string | null;
};

export function toInbox(row: NotificationRow): InboxNotification {
  return {
    id: row.id,
    type: row.type as NotificationType,
    targetType: row.target_type as NotificationTargetType,
    targetId: row.target_id,
    title: row.title ?? "",
    body: row.body ?? "",
    read: row.read ?? false,
    createdAt: row.created_at,
  };
}

/** The screens a notification can deep-link to on WEB. */
export type NotificationTarget = { screen: "horse"; id: string };

/**
 * The screens that actually EXIST on web and can therefore be navigated to.
 *
 * THIS IS WHERE WEB DIVERGES FROM MOBILE, and it is deliberate. Mobile's
 * `ROUTED_SCREENS` is `{'horse','post'}` because mobile has `src/app/post/[id].tsx`.
 * **Web has no post detail route** — `app/(member)/` contains horses/[id] and
 * trainers/[id] and nothing else (verified on this base). So a `post`-targeted
 * alert on web resolves to NULL: it still lists, and it still marks itself read,
 * but it does not navigate.
 *
 * Failing CLOSED like this is the same rule mobile applies to `race` targets, and
 * it is the correct direction: routing `/posts/<id>` to a route that does not
 * exist would render Next's 404 and lose the member's place in the inbox — a
 * well-formed URL addressing nothing, which reads as a broken app rather than as
 * an obviously missing feature.
 *
 * Adding a web post permalink is a separate ticket; when it lands, add "post"
 * here and to `notificationTarget` below.
 */
export const ROUTED_SCREENS: ReadonlySet<NotificationTarget["screen"]> = new Set(["horse"]);

/**
 * What a notification points at on web, or null when it cannot be resolved.
 *
 * ROUTING IS BY `target_type`, NOT BY `type` — the two are easy to conflate. A
 * `race_day` reminder carries `target_type = 'race'` and a RACE id, so routing on
 * `target_id` alone would push `/horses/<race-uuid>`: a valid-looking URL that
 * addresses nothing. `target_type` is the authority on what the id addresses.
 *
 * A `notification` row carries no horse id, so a `race` target has nothing to
 * fall back to on web (mobile can only resolve those from a push payload's
 * `horse_id` hint). It lists and marks read without navigating. Guessing a horse
 * from a race id would need a `race_horse` lookup that is genuinely ambiguous —
 * a race has many runners — so it is not attempted.
 */
export function notificationTarget(n: {
  targetType?: string | null;
  targetId?: string | null;
}): NotificationTarget | null {
  const id = typeof n.targetId === "string" ? n.targetId.trim() : "";
  switch (n.targetType) {
    case "horse":
      return id ? { screen: "horse", id } : null;
    case "post":
    case "race":
      // No web screen addresses these today — see ROUTED_SCREENS.
      return null;
    default:
      // Fail CLOSED on an unknown target_type: a new server-side target must not
      // become a navigation to a guessed route.
      return null;
  }
}

/**
 * The concrete href for a target. A gated detail route.
 *
 * A `switch` on `screen` rather than a bare horse template, deliberately. The
 * note on ROUTED_SCREENS says a future post permalink is added by putting
 * `"post"` in that set — and with an unconditional `/horses/${id}` here, doing
 * exactly that would send post rows to `/horses/<post-uuid>`: the very
 * "valid-looking URL that addresses nothing" this module exists to prevent.
 * Switching means the two cannot drift — widening the set without widening this
 * function is a type error, not a silent dead link.
 */
export function targetHref(target: NotificationTarget): string {
  switch (target.screen) {
    case "horse":
      return `/horses/${target.id}`;
  }
}

/**
 * The target to actually navigate to — `notificationTarget` narrowed to the
 * screens that exist. The screen MUST use this, never `notificationTarget`.
 */
export function navigableTarget(n: {
  targetType?: string | null;
  targetId?: string | null;
}): NotificationTarget | null {
  const target = notificationTarget(n);
  if (!target) return null;
  return ROUTED_SCREENS.has(target.screen) ? target : null;
}

/**
 * The unread chip's label, or null when there is nothing to show.
 * Capped like mobile's `formatUnreadBadge` so a long-dormant inbox cannot widen
 * the sidebar rail with a four-digit number.
 */
export const UNREAD_BADGE_CAP = 99;

export function formatUnreadBadge(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(Math.floor(count));
}

/**
 * Fired on `window` by the inbox whenever it changes what is unread, so the
 * sidebar chip can re-read the count.
 *
 * The ticket only asks for the chip to refresh ON NAVIGATION, and it does — but
 * "Mark all read" is the one case where the member changes the count WITHOUT
 * navigating, and the two then visibly contradict each other: every row on the
 * screen is cleared while the chip next to it still claims 2 unread. A DOM event
 * rather than shared state or a store because the sidebar lives in the layout
 * and the inbox in the page: they have no common React ancestor below the server
 * layout, so there is nothing to lift the state into without making the shell a
 * client component.
 */
export const UNREAD_CHANGED_EVENT = "stablepass:unread-changed";

/** Safe in a server render (no `window`), where it is simply a no-op. */
export function announceUnreadChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT));
}
