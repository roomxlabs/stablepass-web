"use client";

// HorsePosts — the horse-profile "Recent updates" column (07-horse-profile.html).
// Fetches this horse's own published posts via the BFF (`/api/horses/:id/feed` —
// a direct read, not the be feed fn), enriches with the viewer's own
// reaction/bookmark rows, and wires <PostCard>'s react/bookmark/play callbacks
// via supabaseBrowser — the same fetch/enrich/mutate shape as W6 explore-feed,
// scoped to one horse and without tabs. Pages by `?cursor=` since ENG-1633, with
// page N+1 started at <= 5 cards left and playback pre-minted for the card on
// screen (useFeedPrefetch) — the same as the other four feeds.
import { useCallback, useEffect, useRef, useState } from "react";
import { HlsVideo } from "@/components/hls-video";
import { useFeedPlayback } from "@/lib/feed/use-feed-playback";
import { useFeedPrefetch } from "@/lib/feed/use-feed-prefetch";
import { PostCard, PostAvatar, mediaBoxProps } from "@/components/post-card";
import { ReactionBar } from "@/components/reaction-bar";
import { supabaseBrowser } from "@/lib/supabase/client";
import { PostMediaError, resolvePostDisplayUrls, type PostDisplayMedia } from "@/lib/api/post-media";
import { postIntrinsics, type PostIntrinsicRow } from "@/lib/feed/post-row";
import type { FeedPost, ReactionEmoji } from "@/components/types";
import { apiFetch } from "@/lib/api/client";

type PostRow = PostIntrinsicRow;
type ReactionRow = { post_id: string; emoji: ReactionEmoji };
type BookmarkRow = { post_id: string };

export interface HorsePostsProps {
  horseId: string;
  horseName: string;
  trainerName: string;
  /** `trainer.stable_name` — the STABLE UPDATE panel footer. Passed down from the
   *  page, which already selects it; this screen makes no trainer read of its own. */
  stableName?: string | null;
  /** `trainer.location` — the other half of that footer. */
  stableLocation?: string | null;
  /** This horse's ALREADY-SIGNED photo — the page signs it once as `coverUrl`
   *  and this prop reuses that value rather than signing a second time (ENG-958). */
  horsePhotoUrl?: string | null;
  /** The trainer's ALREADY-SIGNED photo — the STABLE UPDATE card's head/footer avatar. */
  trainerPhotoUrl?: string | null;
  viewerId: string;
}

export function HorsePosts({ horseId, horseName, trainerName, stableName = null, stableLocation = null, horsePhotoUrl = null, trainerPhotoUrl = null, viewerId }: HorsePostsProps) {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // The ONE player state, shared by all five feeds (ENG-1599, grown from
  // ENG-1063's failure hook): one playing `postId:videoIndex` feed-wide, the
  // pill map, and the mint. See the hook for why a copy per feed was the bug.
  const playback = useFeedPlayback();
  const resetPlayback = playback.reset;
  // Paging (ENG-1633). `loadingMore` is page 2+ only: page 1 keeps `loading`,
  // which is what draws the skeleton.
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  // Bumped when the horse (or its identity props) changes: an answer for the
  // previous horse must not land on this one — the old effect's `cancelled`.
  const generation = useRef(0);

  const fetchPage = useCallback(async (forCursor: string | null) => {
    if (forCursor && loadingRef.current) return;
    const gen = forCursor ? generation.current : ++generation.current;
    const cancelled = () => gen !== generation.current;
    // A failed page 1 is the error state; a failed LATER page only stops paging
    // — it must not blank the posts already on screen.
    const fail = () => (forCursor ? setHasMore(false) : setError(true));
    loadingRef.current = true;
    if (forCursor) setLoadingMore(true);
    else {
      setLoading(true);
      setError(false);
      resetPlayback();
    }
    try {
      const params = new URLSearchParams();
      if (forCursor) params.set("cursor", forCursor);
      const qs = params.toString();
      const res = await apiFetch(`/api/horses/${horseId}/feed${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        if (!cancelled()) fail();
        return;
      }
      const body = await res.json();
      const rows = (body.data ?? []) as PostRow[];
      const meta = (body.meta ?? {}) as { nextCursor?: string | null; hasMore?: boolean };
      // Committed only where the rows land (the rule the other feeds follow).
      const commitPaging = () => {
        setCursor(meta.nextCursor ?? null);
        setHasMore(Boolean(meta.hasMore));
      };
      if (rows.length === 0) {
        if (!cancelled()) {
          if (!forCursor) setPosts([]);
          commitPaging();
        }
        return;
      }

      const ids = rows.map((r) => r.id);
      const sb = supabaseBrowser();
      const [{ data: reactionRows }, { data: bookmarkRows }] = await Promise.all([
        sb.from("reaction").select("post_id,emoji").in("post_id", ids),
        sb.from("bookmark").select("post_id").in("post_id", ids),
      ]);
      const myReaction = new Map(((reactionRows ?? []) as ReactionRow[]).map((r) => [r.post_id, r.emoji]));
      const mySet = new Set(((bookmarkRows ?? []) as BookmarkRow[]).map((b) => b.post_id));
      // Photos, slide counts AND slot-0 video posters via ONE POST /api/posts/media
      // (ENG-1633; posterOnly only where the batch had none). Absolute URLs pass through. A 402 surfaces the
      // AccessWall (guardrail 3). `slideCounts` rides in on the same batch, which
      // is what lets a carousel draw the right dots before it mints a thing.
      let media: PostDisplayMedia;
      try {
        media = await resolvePostDisplayUrls(rows);
      } catch (e) {
        if (e instanceof PostMediaError && e.reason === "gated") {
          // Profile pages already wall at the page level; mid-session 402 → error.
          if (!cancelled()) fail();
          return;
        }
        media = { urls: new Map(), slideCounts: new Map() };
      }

      const intrinsics = { signedMedia: media.urls, slideCountByPost: media.slideCounts, reactionByPost: myReaction };
      const mapped: FeedPost[] = rows.map((r) => ({
        ...postIntrinsics(r, intrinsics),
        horseId,
        horseName,
        trainerName,
        stableName,
        stableLocation,
        horsePhotoUrl,
        trainerPhotoUrl,
        bookmarked: mySet.has(r.id),
      }));
      if (!cancelled()) {
        setPosts((prev) => (forCursor ? [...prev, ...mapped] : mapped));
        commitPaging();
      }
    } finally {
      if (!cancelled()) {
        loadingRef.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [horseId, horseName, trainerName, stableName, stableLocation, horsePhotoUrl, trainerPhotoUrl, resetPlayback]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch, not derived state
    void fetchPage(null);
    return () => {
      generation.current += 1;
      loadingRef.current = false;
    };
  }, [fetchPage]);

  useFeedPrefetch({
    sentinelRef,
    posts,
    playback,
    canLoadMore: hasMore && !loading && !loadingMore && !error,
    cursor,
    loadMore: () => void fetchPage(cursor),
  });

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

  async function bookmark(postId: string) {
    const target = posts.find((p) => p.id === postId);
    if (!target) return;
    const prevBookmarked = target.bookmarked;
    const nextBookmarked = !prevBookmarked;

    setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, bookmarked: nextBookmarked } : p)));

    const sb = supabaseBrowser();
    const { error: bookmarkError } = nextBookmarked
      ? await sb.from("bookmark").insert({ user_id: viewerId, post_id: postId })
      : await sb.from("bookmark").delete().eq("post_id", postId);

    if (bookmarkError) {
      setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, bookmarked: prevBookmarked } : p)));
    }
  }

  if (loading) {
    return <div className="post-web" aria-hidden="true" style={{ height: 220, background: "var(--line)" }} />;
  }
  if (error) {
    return <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load this horse&rsquo;s updates.</p>;
  }
  if (posts.length === 0) {
    return <p style={{ color: "var(--muted)", padding: "24px 0" }}>No updates yet.</p>;
  }

  return (
    <>
      {posts.map((p) => {
        const playbackUrl = playback.inlineUrl(p);
        if (playbackUrl) {
          return (
            <article className="post-web" key={p.id}>
              <div className="post-head-web">
                <PostAvatar url={p.horsePhotoUrl} initial={p.horseName[0]?.toUpperCase() ?? "?"} />
                <div className="post-meta-web">
                  <h3 className="post-horse">{p.horseName}</h3>
                  {/* title on a media card is withheld (client, 18 Aug 2026) — see post-card.tsx */}
                  <div className="post-byline">
                    <span className="by-trainer">{p.trainerName}</span> · {p.postedAgo}
                  </div>
                </div>
              </div>
              <div {...mediaBoxProps(p.media.aspectRatio, { video: true })}>
                <HlsVideo
                  src={playbackUrl}
                  poster={p.media.posterUrl ?? undefined}
                  controls
                  playsInline
                  // Deliberately NO `autoPlay`: HlsVideo issues its own explicit play()
                  // once the transport is ready (ENG-1056), which is what Safari honours
                  // on a freshly-mounted, click-initiated element.
                  onFatalError={() => playback.onFatal(p.id)}
                />
              </div>
              <ReactionBar
                count={p.count}
                reacted={p.reacted}
                bookmarked={p.bookmarked}
                onReact={(e) => react(p.id, e)}
                onBookmark={() => bookmark(p.id)}
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
              onBookmark={() => bookmark(p.id)}
              onPlay={() => void playback.play(p.id)}
              playback={playback}
            />
            {playback.failed(p.id) && (
              <p role="alert" style={{ color: "var(--red)", marginTop: -16, marginBottom: 24, fontSize: 13.5 }}>
                Couldn&rsquo;t load the video.
              </p>
            )}
          </div>
        );
      })}
      {/* End-of-list sentinel (ENG-1633): the paging fallback, and the anchor
          under whose parent useFeedPrefetch finds these cards. */}
      <div ref={sentinelRef} />
    </>
  );
}
