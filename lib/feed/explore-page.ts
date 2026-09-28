// One Explore feed page: bare `post` rows in, card view models out (ENG-1593).
//
// Shared by BOTH halves of the Explore screen, which is why it lives in a
// directive-free `lib/` module (a server component cannot call an export of a
// "use client" file — .rx/gotchas.md, ENG-959):
//   - `app/(member)/explore/page.tsx` runs it on the SERVER for page 1, with the
//     cookie-bound server client and the edge media transport;
//   - `ExploreFeed` runs it in the BROWSER for every later page, with
//     `supabaseBrowser()` and the BFF media transport.
// Same reads, same mapping, same failure semantics, so the server-rendered page
// and a client-fetched one cannot drift apart.
//
// THE WATERFALL THIS REMOVES. The page used to resolve identity, reactions and
// bookmarks, and only THEN start minting media — although the mint needs
// nothing but the rows. All four now start together, so a page costs one round
// of parallel reads instead of two in series.
//
// IT DOES NOT GATE. Every caller already holds rows from the `feed` edge
// function, which is the content gate (402 for a lapsed member). The media
// mint re-gates on its own, and a 402 there surfaces here as `gated` — never as
// an empty page that could be mistaken for "no posts".
import type { SupabaseClient } from "@supabase/supabase-js";

import type { FeedPost, ReactionEmoji } from "@/components/types";
import { PostMediaError, type PostDisplayMedia } from "@/lib/api/post-media";
import { postIntrinsics, type PostIntrinsicRow } from "@/lib/feed/post-row";
import { enrichFeedSubjects } from "@/lib/feed/subject";

/** Explore's page size, for the server-rendered page 1 and every client page after it. */
export const EXPLORE_PAGE_SIZE = 10;

/** The page-1 hand-off from the server component to the ExploreFeed island. Plain JSON only. */
export type ExploreInitialPage =
  | { kind: "ok"; posts: FeedPost[]; nextCursor: string | null; hasMore: boolean }
  | { kind: "gated" };

export type AssembledFeedPage =
  | { kind: "ok"; posts: FeedPost[] }
  | { kind: "gated" }
  | { kind: "error" };

type ReactionRow = { post_id: string; emoji: ReactionEmoji };
type BookmarkRow = { post_id: string };

const GATED = Symbol("gated");

export async function assembleExplorePage(
  sb: SupabaseClient,
  rows: PostIntrinsicRow[],
  resolveMedia: (rows: PostIntrinsicRow[]) => Promise<PostDisplayMedia>,
): Promise<AssembledFeedPage> {
  if (rows.length === 0) return { kind: "ok", posts: [] };
  const ids = rows.map((r) => r.id);

  const [{ identityById, error: identityError }, { data: reactionRows }, { data: bookmarkRows }, media] =
    await Promise.all([
      // ONE subject-aware identity read for the page (ENG-1270).
      enrichFeedSubjects(sb, rows),
      sb.from("reaction").select("post_id,emoji").in("post_id", ids),
      sb.from("bookmark").select("post_id").in("post_id", ids),
      // Photos + slide counts in ONE batch, video posters alongside it. A 402
      // is the reactivate wall (guardrail 3) and must not be swallowed into an
      // empty map; anything else degrades to placeholders, never a crash.
      resolveMedia(rows).catch((e: unknown): PostDisplayMedia | typeof GATED =>
        e instanceof PostMediaError && e.reason === "gated"
          ? GATED
          : { urls: new Map(), slideCounts: new Map() },
      ),
    ]);

  // A REJECTED identity read (not merely empty) must not paint: every card
  // would read "Unknown horse" over a blank byline and the page would look
  // fine. The screen raises the same error state a failed feed fetch raises.
  if (identityError) return { kind: "error" };
  if (media === GATED) return { kind: "gated" };

  const myReaction = new Map(((reactionRows ?? []) as ReactionRow[]).map((r) => [r.post_id, r.emoji]));
  const mySet = new Set(((bookmarkRows ?? []) as BookmarkRow[]).map((b) => b.post_id));
  const intrinsics = { signedMedia: media.urls, slideCountByPost: media.slideCounts, reactionByPost: myReaction };

  return {
    kind: "ok",
    posts: rows.map((r) => ({
      ...postIntrinsics(r, intrinsics),
      ...identityById.get(r.id)!,
      bookmarked: mySet.has(r.id),
    })),
  };
}
