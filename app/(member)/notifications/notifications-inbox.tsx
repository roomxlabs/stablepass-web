"use client";

// The notification inbox — /notifications. ENG-957.
//
// THE BUG THIS CLOSES: `app/(member)/sidebar.tsx` has linked /notifications
// since the shell was built, and no such route existed — the link was a live
// 404 on every member screen.
//
// NO MOCKUP EXISTS for this screen. `.rx/mockups.md` lists no notifications
// screen for web, and mobile records the same gap for its Alerts tab. It is
// therefore built from the web design system alone (`app/globals.css` tokens —
// no eyeballed hex or spacing) with mobile's Alerts tab
// (`src/app/(tabs)/alerts.tsx`) as the behaviour + copy reference, so the two
// platforms say the same things to the same member. The empty state's copy is
// mobile's, word for word.
//
// The visual rule, ported from mobile: READ rows sit flat on the cream canvas;
// UNREAD rows are raised on white with a brand-green leading glyph and a green
// dot. "What's new" is then legible at a glance without a second colour or a
// per-row count.
//
// Guardrails visible on this screen (.rx/guardrails.md):
//  - Every read and write goes through the BFF in `app/api/notifications/*`,
//    which scopes to the session's OWN rows; this screen never sends a user id.
//  - Rows open by ROUTE, so the horse profile applies the subscription gate: a
//    member who lapses while the inbox is open lands on the reactivate wall
//    rather than inside gated content.
//  - No owner PII is read or shown — the BFF names an explicit column allow-list.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { relativeTime } from "@/lib/feed/post-row";
import {
  announceUnreadChanged,
  navigableTarget,
  targetHref,
  type InboxNotification,
  type NotificationType,
} from "@/app/api/notifications/contract";
import styles from "./notifications-inbox.module.css";

// The glyph each alert type gets, in the sidebar's stroke idiom (24-box, 1.8
// stroke via the shared `.ic` class) so the inbox reads as the same app.
const TYPE_ICON: Record<NotificationType, React.ReactNode> = {
  // new_post — a new update to watch.
  new_post: <path d="M8 5.5v13l11-6.5Z" />,
  // race_day — the 2h-before reminder. The sidebar's own bell.
  race_day: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  // race_result — the result is in.
  race_result: <path d="M4 12.5 9.5 18 20 7" />,
  // milestone — first win, retirement.
  milestone: <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" />,
};

const FALLBACK_ICON = TYPE_ICON.race_day;

function TypeIcon({ type }: { type: NotificationType }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
      {TYPE_ICON[type] ?? FALLBACK_ICON}
    </svg>
  );
}

type Envelope = { data?: InboxNotification[]; meta?: { hasMore?: boolean } };

export function NotificationsInbox() {
  const router = useRouter();

  const [items, setItems] = useState<InboxNotification[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const unreadCount = items?.filter((n) => !n.read).length ?? 0;

  // Every setState here lands AFTER the first await, deliberately: this runs
  // straight out of an effect, and a synchronous setState in that position
  // triggers a cascading re-render (the repo's eslint config fails the build on
  // it). The old error is therefore cleared on success rather than up front.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Envelope;
      setItems(body.data ?? []);
      setHasMore(Boolean(body.meta?.hasMore));
      setError(null);
      setLoadFailed(false);
    } catch {
      setError("We couldn’t load your notifications.");
      setLoadFailed(true);
    }
  }, []);

  // The async IIFE is the repo's idiom for this (see shares-list / saved-feed):
  // an effect that calls a state-setting function directly trips the
  // cascading-render rule, and every setState below lands after an await.
  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  /** Cursored on the oldest row we hold — an offset would skip or repeat a row
   *  when a new alert arrives between pages. */
  const loadMore = useCallback(async () => {
    const oldest = items?.[items.length - 1]?.createdAt;
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/notifications?before=${encodeURIComponent(oldest)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as Envelope;
      setItems((current) => [...(current ?? []), ...(body.data ?? [])]);
      setHasMore(Boolean(body.meta?.hasMore));
    } catch {
      setError("We couldn’t load more notifications.");
    } finally {
      setLoadingMore(false);
    }
  }, [items, loadingMore]);

  /** Marks one row read locally first, so the dot clears on click. */
  const openRow = useCallback(
    (item: InboxNotification) => {
      if (!item.read) {
        setItems((current) =>
          (current ?? []).map((n) => (n.id === item.id ? { ...n, read: true } : n)),
        );
        // Fire-and-forget, deliberately (mobile made the same call): a read
        // RECEIPT must not gate access to the content. Awaiting it makes every
        // click feel dead for a round-trip, and makes an unread alert entirely
        // un-openable on a flaky connection.
        void fetch(`/api/notifications/${item.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ read: true }),
          keepalive: true,
        })
          .then((res) => {
            if (!res.ok) throw new Error(String(res.status));
            // The row is read on the server now — let the sidebar chip catch up.
            announceUnreadChanged();
          })
          .catch(() => {
            // Put the dot back — the row is still unread on the server.
            setItems((current) =>
              (current ?? []).map((n) => (n.id === item.id ? { ...n, read: false } : n)),
            );
            setError("We couldn’t mark that alert read.");
          });
      }

      // `navigableTarget`, not `notificationTarget`: an alert whose screen does
      // not exist on web still marks read but must NOT navigate. Pushing a route
      // with no page renders a 404 and loses the member's place in the inbox.
      const target = navigableTarget(item);
      if (target) router.push(targetHref(target));
    },
    [router],
  );

  const markEvery = useCallback(async () => {
    const previous = items ?? [];
    setItems(previous.map((n) => ({ ...n, read: true })));
    try {
      const res = await fetch("/api/notifications/read-all", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      announceUnreadChanged();
    } catch {
      setItems(previous);
      setError("We couldn’t mark your alerts read.");
    }
  }, [items]);

  const isLoading = items === null && !loadFailed;

  return (
    <div className={styles.screen}>
      <div className={styles.head}>
        <h1 className={`section-title-web ${styles.title}`}>Notifications</h1>
        {unreadCount > 0 && (
          <button
            type="button"
            className={styles.markAll}
            data-testid="notifications-mark-all"
            aria-label={`Mark all ${unreadCount} notifications read`}
            onClick={() => void markEvery()}
          >
            Mark all read
          </button>
        )}
      </div>

      {/* Outside the list: a WRITE failure (mark-read / mark-all) happens while
          the list is populated, so an error rendered only in the empty state
          could never actually be seen. */}
      {error && !loadFailed && (
        <p className={styles.errorBanner} data-testid="notifications-error" role="alert">
          {error}
        </p>
      )}

      {isLoading && (
        <div data-testid="notifications-loading" aria-hidden="true">
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
          <div className={styles.skeleton} />
        </div>
      )}

      {loadFailed && (
        <div className={styles.message}>
          <h2 className={styles.messageTitle} role="alert">
            {error}
          </h2>
          <button
            type="button"
            className="btn btn-light"
            data-testid="notifications-retry"
            onClick={() => {
              // `setError(null)` as well as clearing the failed flag — mobile's
              // retry handler does both. Without it, `error` survives while
              // `loadFailed` goes false, which is exactly the condition the
              // populated-list error banner renders on: the old failure would
              // sit above the loading skeleton for the whole retry round-trip.
              setError(null);
              setLoadFailed(false);
              void load();
            }}
          >
            Try again
          </button>
        </div>
      )}

      {/* Mobile's Alerts empty state, copy unchanged. */}
      {!isLoading && !loadFailed && items?.length === 0 && (
        <div className={styles.message} data-testid="notifications-empty">
          <span className={styles.emptyGlyph} aria-hidden="true">
            <svg className="ic" viewBox="0 0 24 24">
              {TYPE_ICON.race_day}
            </svg>
          </span>
          <h2 className={styles.messageTitle}>No alerts yet</h2>
          <p className={styles.messageBody}>
            Race-day reminders, results and new stable updates will appear here.
          </p>
        </div>
      )}

      {!loadFailed && items && items.length > 0 && (
        <>
          <ul className={styles.list} data-testid="notifications-list">
            {items.map((item) => {
              const unread = !item.read;
              const opens = navigableTarget(item) !== null;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`${styles.row} ${unread ? styles.rowUnread : ""}`}
                    data-testid={`notifications-row-${item.id}`}
                    onClick={() => openRow(item)}
                    // Do not promise a screen this row cannot open — a row that
                    // only marks itself read should say so rather than reading
                    // as a dead link.
                    aria-label={`${item.title}. ${item.body}. ${relativeTime(item.createdAt)}${
                      unread ? ". Unread" : ""
                    }`}
                    title={opens ? undefined : "Marks this alert read"}
                  >
                    <span
                      className={`${styles.glyph} ${unread ? styles.glyphUnread : styles.glyphRead}`}
                      aria-hidden="true"
                    >
                      <TypeIcon type={item.type} />
                    </span>

                    <span className={styles.rowBody}>
                      <span className={`${styles.rowTitle} ${unread ? styles.rowTitleUnread : ""}`}>
                        {item.title}
                      </span>
                      <span className={styles.rowText}>{item.body}</span>
                      <span className={styles.time}>{relativeTime(item.createdAt)}</span>
                    </span>

                    {unread && (
                      <span
                        className={styles.dot}
                        data-testid={`notifications-unread-${item.id}`}
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          {hasMore && (
            <div className={styles.more}>
              <button
                type="button"
                className="btn btn-light"
                data-testid="notifications-load-more"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
