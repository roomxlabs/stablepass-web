"use client";

// SavedFeed — the Saved (bookmarks) screen (W12). The member's saved posts, styled
// like Explore: a single PostCard column, newest-saved-first. Mirrors explore-feed.tsx
// (client fetch + enrich + engagement) but reads the bookmark→post join directly
// (RLS-scoped supabaseBrowser) instead of the ranked feed BFF, records NO impressions,
// and — since this IS the "saved" list — an unsave removes the card.
import { useCallback, useEffect, useRef, useState } from "react";
import { ACCESS_COLUMNS, hasAccess, type AccessRow } from "@/lib/api/access";
import { AccessWall } from "@/components/access-wall";
import { HlsVideo } from "@/components/hls-video";
import { useFeedVideoFailure } from "@/lib/feed/use-feed-video-failure";
import { PostCard, mediaBoxProps } from "@/components/post-card";
import { PostHead } from "@/components/post-head";
import { ReactionBar } from "@/components/reaction-bar";
import { supabaseBrowser } from "@/lib/supabase/client";
import { PostMediaError, resolvePostDisplayUrls, type PostDisplayMedia } from "@/lib/api/post-media";
import { postIntrinsics, type PostIntrinsicRow } from "@/lib/feed/post-row";
import { enrichFeedSubjects } from "@/lib/feed/subject";
import type { FeedPost, ReactionEmoji } from "@/components/types";
import { apiFetch } from "@/lib/api/client";

const LIMIT = 10;

// Bare be `post` row shape — the bookmark→post embed returns full post columns.
// `horse_id` / `source_trainer_id` / `subject` / `byline` ride on the shared row
// type since ENG-1270.
type PostRow = PostIntrinsicRow;
type BookmarkRow = { created_at: string; post: PostRow | PostRow[] | null };

// The horse read, its trainer embed and both photo-signing batches MOVED to
// `lib/feed/subject.ts` at ENG-1270 — this screen has no rails of its own, so
// nothing else here needs horse/trainer identity.
type ReactionRow = { post_id: string; emoji: ReactionEmoji };

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// `everSubscribed` — see the note in ../explore/explore-feed.tsx (server-resolved
// boolean; the Stripe id never reaches the browser).
export function SavedFeed({ viewerId, everSubscribed }: { viewerId: string; everSubscribed: boolean }) {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null); // last bookmark.created_at seen
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [gated, setGated] = useState(false);
  const [playing, setPlaying] = useState<Record<string, string>>({});
  const [playError, setPlayError] = useState<Record<string, boolean>>({});
  // The ONE fatal-transport handler, shared by all five feeds (ENG-1063).
  // It was copy-pasted verbatim into each of them; see the hook for why that
  // mattered even though nothing was wrong with the behaviour.
  const onFatalVideo = useFeedVideoFailure(setPlaying, setPlayError);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const fetchPage = useCallback(async (forCursor: string | null) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(false);
    const sb = supabaseBrowser();
    try {
      // Content gate (client-side, mirrors HorsesGrid/TrainersGrid) — first page only.
      if (!forCursor) {
        const { data: sub } = await sb
          .from("subscription").select(ACCESS_COLUMNS).eq("user_id", viewerId).maybeSingle();
        // ENG-585: this was `!["trial","active"].includes(status)` on a
        // status-only select, so an `active` member whose `current_period_end`
        // had passed counted as entitled here, ran the read, got nothing back
        // (RLS denies them correctly) and saw an EMPTY screen instead of the
        // wall. `hasAccess()` is the shared rule (lib/api/access.ts) — pure and
        // client-safe, already imported this way by the expiry banner.
        //
        // Strictly stricter than the test it replaces: identical for entitled,
        // lapsed and canceled rows, and it additionally catches expired ones. It
        // can only wall MORE members, never reveal content to one.
        if (!hasAccess(sub as AccessRow | null)) {
          setGated(true);
          return;
        }
      }

      // Own bookmarks (RLS `bookmark_rw_self`) embedded with their post (RLS
      // `post_select_sub` gates the embed), newest-saved-first; keyset on created_at.
      // Filters (.lt) must precede transforms (.order/.limit) — supabase-js narrows
      // the builder type after a transform, so keyset paging goes first.
      let q = sb.from("bookmark").select("created_at, post:post_id(*)");
      if (forCursor) q = q.lt("created_at", forCursor);
      const { data: bookmarkRows, error: fetchError } = await q
        .order("created_at", { ascending: false })
        .limit(LIMIT);
      if (fetchError) { setError(true); return; }

      const rows = (bookmarkRows ?? []) as BookmarkRow[];
      // PAGING STATE IS COMMITTED ONLY WHERE THE ROWS ACTUALLY LAND. It used to
      // be set here, before enrichment — which meant the identity-error bail
      // below advanced the cursor past a page it then discarded. Nothing retries
      // today (the sentinel is gated on `!error`), so that was latent rather
      // than broken; it becomes a silent content hole the day anyone adds a
      // "Try again". Explore already had this order; these two now match it.
      const commitPaging = () => {
        setCursor(rows.length ? rows[rows.length - 1].created_at : forCursor);
        setHasMore(rows.length === LIMIT);
      };

      // Drop rows whose post RLS-filtered to null (unpublished/hidden/lost content-access).
      const postRows = rows
        .map((b) => one(b.post))
        .filter((p): p is PostRow => p !== null);

      if (postRows.length === 0) {
        commitPaging();
        if (!forCursor) setPosts([]);
        return;
      }

      const ids = postRows.map((p) => p.id);

      // ONE subject-aware identity read for the page (ENG-1270): the horse read
      // for the non-null `horse_id`s, the trainer read for the trainer-subject
      // rows, and both signing batches.
      const [{ identityById, error: identityError }, { data: reactionRows }] = await Promise.all([
        enrichFeedSubjects(sb, postRows),
        sb.from("reaction").select("post_id,emoji").in("post_id", ids),
      ]);

      // An identity read that was REJECTED (not merely empty) must not paint:
      // every card would read "Unknown horse" over a blank byline and the page
      // would look fine. Raise the same error state a failed feed fetch raises.
      if (identityError) {
        setError(true);
        return;
      }

      const myReaction = new Map(((reactionRows ?? []) as ReactionRow[]).map((r) => [r.post_id, r.emoji]));
      // Photos + their slide counts via ONE POST /api/posts/media; video posters
      // via playback?posterOnly=1. Absolute URLs pass through. A 402 surfaces the
      // AccessWall (guardrail 3). `slideCounts` rides in on the same batch, which
      // is what lets a carousel draw the right dots before it mints a thing.
      let media: PostDisplayMedia;
      try {
        media = await resolvePostDisplayUrls(postRows);
      } catch (e) {
        if (e instanceof PostMediaError && e.reason === "gated") {
          setGated(true);
          return;
        }
        media = { urls: new Map(), slideCounts: new Map() };
      }

      const intrinsics = { signedMedia: media.urls, slideCountByPost: media.slideCounts, reactionByPost: myReaction };
      const mapped: FeedPost[] = postRows.map((r) => ({
        ...postIntrinsics(r, intrinsics),
        ...identityById.get(r.id)!,
        bookmarked: true, // everything on this screen is, by definition, saved
      }));

      setPosts((prev) => (forCursor ? [...prev, ...mapped] : mapped));
      commitPaging();
      // No impression writes: Saved is a curated list, not the ranked feed.
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [viewerId]);

  useEffect(() => {
    fetchPage(null);
  }, [fetchPage]);

  // Infinite scroll — a sentinel at the bottom loads the next page.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    if (!hasMore || loading || gated || error) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) fetchPage(cursor);
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, gated, error, cursor, fetchPage]);

  async function react(postId: string, emoji: ReactionEmoji) {
    const target = posts.find((p) => p.id === postId);
    if (!target) return;
    const prevReacted = target.reacted;
    const nextReacted = prevReacted === emoji ? null : emoji;

    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, reacted: nextReacted } : p)));

    const sb = supabaseBrowser();
    const { error: reactError } = nextReacted
      ? await sb.from("reaction").upsert({ user_id: viewerId, post_id: postId, emoji: nextReacted }, { onConflict: "user_id,post_id" })
      : await sb.from("reaction").delete().eq("post_id", postId);

    if (reactError) {
      setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, reacted: prevReacted } : p)));
    }
  }

  // Unsave — on the Saved screen this REMOVES the card (it's no longer saved).
  async function unsave(postId: string) {
    const idx = posts.findIndex((p) => p.id === postId);
    if (idx === -1) return;
    const removed = posts[idx];

    setPosts((prev) => prev.filter((p) => p.id !== postId));

    const sb = supabaseBrowser();
    const { error: delError } = await sb.from("bookmark").delete().eq("post_id", postId);
    if (delError) {
      // Restore at its original position on failure.
      setPosts((prev) => {
        const next = prev.slice();
        next.splice(Math.min(idx, next.length), 0, removed);
        return next;
      });
    }
  }

  async function play(postId: string) {
    setPlayError((prev) => ({ ...prev, [postId]: false }));
    try {
      const res = await apiFetch(`/api/posts/${postId}/playback`);
      if (res.status !== 200) { setPlayError((prev) => ({ ...prev, [postId]: true })); return; }
      const body = await res.json().catch(() => null);
      const url = body?.data?.playbackUrl as string | undefined;
      if (!url) { setPlayError((prev) => ({ ...prev, [postId]: true })); return; }
      setPlaying((prev) => ({ ...prev, [postId]: url }));
    } catch {
      setPlayError((prev) => ({ ...prev, [postId]: true }));
    }
  }

  // Only "empty" when there's genuinely nothing more — a full page that was
  // entirely RLS-hidden leaves posts=[] with hasMore=true, and must keep paging
  // (via the always-rendered sentinel below), not flash a false empty state.
  const showEmpty = !gated && !error && !loading && posts.length === 0 && !hasMore;
  const showSkeleton = !gated && !error && loading && posts.length === 0;

  return (
    <div className="feed-grid" style={{ justifyContent: "center" }}>
      <div className="feed-col">
        <h1 className="section-title-web" style={{ marginBottom: 20 }}>Saved</h1>

        {gated && <AccessWall everSubscribed={everSubscribed} />}

        {!gated && error && (
          <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load your saved posts.</p>
        )}

        {showSkeleton && (
          <>
            <div className="post-web" aria-hidden="true" style={{ height: 260, background: "var(--line)" }} />
            <div className="post-web" aria-hidden="true" style={{ height: 260, background: "var(--line)" }} />
          </>
        )}

        {showEmpty && (
          <p style={{ color: "var(--muted)", padding: "24px 0" }}>
            You haven&rsquo;t saved any posts yet.{" "}
            <a href="/explore" style={{ color: "var(--brand-green)", fontWeight: 600 }}>Explore posts</a>{" "}
            and tap the bookmark to save them here.
          </p>
        )}

        {!gated && !error && posts.length > 0 && (
          <>
            {posts.map((p) => {
              const playbackUrl = playing[p.id];
              if (playbackUrl) {
                return (
                  <article className="post-web" key={p.id}>
                    {/* THE SAME HEAD THE CARD DRAWS (ENG-1270). This article exists because a
                        playing video replaces the card's media box, not its identity — and the
                        five hand-copied heads this used to be one of are exactly how a trainer
                        video would have kept saying "Unknown horse" here while the card beside
                        it got it right (ENG-558: the second copy is the bug). */}
                    <PostHead post={p} />
                    <div {...mediaBoxProps(p.media.aspectRatio, { video: true })}>
                      <HlsVideo
                        src={playbackUrl}
                        poster={p.media.posterUrl ?? undefined}
                        controls
                        playsInline
                        // Deliberately NO `autoPlay`: HlsVideo issues its own explicit play()
                        // once the transport is ready (ENG-1056), which is what Safari honours
                        // on a freshly-mounted, click-initiated element.
                        onFatalError={() => onFatalVideo(p.id)}
                      />
                    </div>
                    <ReactionBar
                      count={p.count}
                      reacted={p.reacted}
                      bookmarked={p.bookmarked}
                      onReact={(e) => react(p.id, e)}
                      onBookmark={() => unsave(p.id)}
                    />
                    {/* Caption below the reaction bar, same as PostCard. */}
                    {p.body && <div className="post-body-web">{p.body}</div>}
                  </article>
                );
              }
              return (
                <div key={p.id}>
                  <PostCard
                    post={p}
                    viewerId={viewerId}
                    onReact={(e) => react(p.id, e)}
                    onBookmark={() => unsave(p.id)}
                    onPlay={() => play(p.id)}
                  />
                  {playError[p.id] && (
                    <p role="alert" style={{ color: "var(--red)", marginTop: -16, marginBottom: 24, fontSize: 13.5 }}>
                      Couldn&rsquo;t load the video.
                    </p>
                  )}
                </div>
              );
            })}
          </>
        )}

        {/* Infinite-scroll sentinel — rendered whenever more pages remain, even at
            posts.length === 0, so a fully RLS-hidden page auto-advances instead of
            showing a false "empty". */}
        {!gated && !error && hasMore && <div ref={sentinelRef} />}
      </div>
    </div>
  );
}
