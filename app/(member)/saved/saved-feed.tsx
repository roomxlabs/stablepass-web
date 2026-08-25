"use client";

// SavedFeed — the Saved (bookmarks) screen (W12). The member's saved posts, styled
// like Explore: a single PostCard column, newest-saved-first. Mirrors explore-feed.tsx
// (client fetch + enrich + engagement) but reads the bookmark→post join directly
// (RLS-scoped supabaseBrowser) instead of the ranked feed BFF, records NO impressions,
// and — since this IS the "saved" list — an unsave removes the card.
import { useCallback, useEffect, useRef, useState } from "react";
import { ACCESS_COLUMNS, hasAccess, type AccessRow } from "@/lib/api/access";
import { AccessWall } from "@/components/access-wall";
import { PostCard, mediaBoxProps } from "@/components/post-card";
import { ReactionBar } from "@/components/reaction-bar";
import { supabaseBrowser } from "@/lib/supabase/client";
import { PostMediaError, resolvePostDisplayUrls, type PostDisplayMedia } from "@/lib/api/post-media";
import { postIntrinsics, type PostIntrinsicRow } from "@/lib/feed/post-row";
import type { FeedPost, ReactionEmoji } from "@/components/types";

const LIMIT = 10;

// Bare be `post` row shape — the bookmark→post embed returns full post columns.
type PostRow = PostIntrinsicRow & { horse_id: string };
type BookmarkRow = { created_at: string; post: PostRow | PostRow[] | null };

// `stable_name`/`location` for the STABLE UPDATE panel footer. Stable identity
// only — there is no owner field here and none may be added.
type HorseTrainer = { name: string; stable_name: string | null; location: string | null };
type HorseRow = { id: string; display_name: string; trainer: HorseTrainer | HorseTrainer[] | null };
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
      setCursor(rows.length ? rows[rows.length - 1].created_at : forCursor);
      setHasMore(rows.length === LIMIT);

      // Drop rows whose post RLS-filtered to null (unpublished/hidden/lost content-access).
      const postRows = rows
        .map((b) => one(b.post))
        .filter((p): p is PostRow => p !== null);

      if (postRows.length === 0) {
        if (!forCursor) setPosts([]);
        return;
      }

      const ids = postRows.map((p) => p.id);
      const horseIds = [...new Set(postRows.map((p) => p.horse_id))];
      const [{ data: horseRows }, { data: reactionRows }] = await Promise.all([
        // `sb` is untyped, so `tsc` can never catch a too-narrow `.select()`. Pinned by a test.
        sb.from("horse").select("id, display_name, trainer:trainer_id(name, stable_name, location)").in("id", horseIds),
        sb.from("reaction").select("post_id,emoji").in("post_id", ids),
      ]);

      const horseById = new Map(((horseRows ?? []) as HorseRow[]).map((h) => [h.id, h]));
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
      const mapped: FeedPost[] = postRows.map((r) => {
        const horse = horseById.get(r.horse_id);
        const trainer = one(horse?.trainer ?? null);
        return {
          ...postIntrinsics(r, intrinsics),
          horseId: r.horse_id,
          horseName: horse?.display_name ?? "Unknown horse",
          trainerName: trainer?.name ?? "Stablepass",
          stableName: trainer?.stable_name ?? null,
          stableLocation: trainer?.location ?? null,
          bookmarked: true, // everything on this screen is, by definition, saved
        };
      });

      setPosts((prev) => (forCursor ? [...prev, ...mapped] : mapped));
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
      const res = await fetch(`/api/posts/${postId}/playback`);
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
                    <div className="post-head-web">
                      <div className="post-avatar-web" aria-hidden="true">{p.horseName[0]?.toUpperCase() ?? "?"}</div>
                      <div className="post-meta-web">
                        <h3 className="post-horse">{p.horseName}</h3>
                        {/* title on a media card is withheld (client, 18 Aug 2026) — see post-card.tsx */}
                        <div className="post-byline">
                          <span className="by-trainer">{p.trainerName}</span> · {p.postedAgo}
                        </div>
                      </div>
                    </div>
                    <div {...mediaBoxProps(p.media.aspectRatio, { video: true })}>
                      <video controls autoPlay src={playbackUrl} />
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
