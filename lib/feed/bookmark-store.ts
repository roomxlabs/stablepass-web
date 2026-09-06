// Cross-surface bookmark sync (ENG-961).
//
// FIVE member screens hold their own copy of `bookmarked` — explore-feed,
// following-screen, saved-feed, trainers/[id]/trainer-posts and
// horses/[id]/horse-posts. (The ticket said "four feed screens"; the horse
// profile feed is the fifth, added since. See the PR note.) Each one reads its
// own `bookmark` rows on mount and patches only its OWN array on toggle, so a
// save made on Explore left Saved/Following showing stale state until a full
// reload.
//
// Every write already funnels through a per-screen `bookmark()`/`unsave()`, so
// this module is the one choke point. Mirrors the mobile precedent
// (`subscribeBookmarkChanges` in stablepass-mobile `lib/engagement.ts`):
//
//   - emit on write SUCCESS only. The screens roll their own optimistic state
//     back when the write fails, so emitting optimistically would broadcast a
//     change that never landed and leave every OTHER screen wrong with no
//     rollback of its own.
//   - a listener never writes; it only patches local state. No fan-out loops.
//
// Deliberately a plain module-level Set rather than React Context: these five
// screens are separate routes that are never mounted under a common client
// provider, so a Context would not reach across them.

export type BookmarkListener = (postId: string, bookmarked: boolean) => void;

const listeners = new Set<BookmarkListener>();

/**
 * Subscribe to confirmed bookmark writes made on ANY surface.
 * Returns an unsubscribe function (call it from the effect's cleanup).
 */
export function subscribeBookmarkChanges(listener: BookmarkListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Announce a bookmark write that the server has ACCEPTED. Call it only after
 * the insert/delete came back without an error.
 *
 * Iterates a copy so a listener that unsubscribes while being notified (a
 * screen unmounting mid-emit) cannot mutate the set under the loop.
 */
export function emitBookmarkChange(postId: string, bookmarked: boolean): void {
  for (const listener of [...listeners]) listener(postId, bookmarked);
}

/** Test-only: drop every listener so one test's mounts cannot leak into the next. */
export function resetBookmarkListeners(): void {
  listeners.clear();
}
