"use client";

// TrainerPosts — the trainer-profile "Recent updates" column (W8). Fetches this
// trainer's own published posts via the BFF (`/api/trainers/:id/feed` — a direct
// read, not the be feed fn), enriches with the viewer's own reaction/bookmark rows,
// and wires <PostCard>'s react/bookmark/play callbacks via supabaseBrowser. Unlike
// the horse version, a trainer's updates span their whole stable, so each post
// carries its OWN horse name for the byline. Mirrors W7 HorsePosts otherwise —
// including, since ENG-1633, `?cursor=` paging with page N+1 started at <= 5
// cards left and playback pre-minted for the card on screen (useFeedPrefetch).
import { useCallback, useEffect, useRef, useState } from "react";
import { HlsVideo } from "@/components/hls-video";
import { useFeedPlayback } from "@/lib/feed/use-feed-playback";
import { useFeedPrefetch } from "@/lib/feed/use-feed-prefetch";
import { PostCard, mediaBoxProps } from "@/components/post-card";
import { PostHead } from "@/components/post-head";
import { ReactionBar } from "@/components/reaction-bar";
import { supabaseBrowser } from "@/lib/supabase/client";
import { signPhotoMap, HORSE_PHOTO_BUCKET } from "@/lib/storage/photos";
import { PostMediaError, resolvePostDisplayUrls, type PostDisplayMedia } from "@/lib/api/post-media";
import { postIntrinsics, type PostIntrinsicRow } from "@/lib/feed/post-row";
import { postSubjectOf, buildPostHead } from "@/lib/feed/subject";
import type { FeedPost, ReactionEmoji } from "@/components/types";
import { displayHorseNameOrEmpty } from "@/lib/format/horse-name";
import { apiFetch } from "@/lib/api/client";

// `photo_url` is a bare object path in the PRIVATE `horse-photos` bucket — this
// route is a plain BFF read (not a signing surface), so the SCREEN batch-signs
// it client-side with `signPhotoMap`, same rule as every other feed mapper (ENG-958).
type HorseRef = { display_name: string; racing_name: string | null; photo_url: string | null };
// `horse_id` comes from the SHARED row type, where it is correctly nullable
// since B1 — a trainer-subject post on this very route has none. Re-declaring
// it as `string` here (as this line did before ENG-1270) made `tsc` believe
// something the BE contradicts, and made the `?? null` below read as dead code.
type PostRow = PostIntrinsicRow & { horse: HorseRef | HorseRef[] | null };
type ReactionRow = { post_id: string; emoji: ReactionEmoji };
type BookmarkRow = { post_id: string };

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export interface TrainerPostsProps {
  trainerId: string;
  trainerName: string;
  /** `trainer.stable_name` — the STABLE UPDATE panel footer. Passed down from the
   *  page, which already selects it; this screen makes no trainer read of its own. */
  stableName?: string | null;
  /** `trainer.location` — the other half of that footer. */
  stableLocation?: string | null;
  /** This trainer's ALREADY-SIGNED photo — the page signs it once as `coverUrl`
   *  and this prop reuses that value rather than signing a second time (ENG-958). */
  trainerPhotoUrl?: string | null;
  viewerId: string;
}

export function TrainerPosts({ trainerId, trainerName, stableName = null, stableLocation = null, trainerPhotoUrl = null, viewerId }: TrainerPostsProps) {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // The ONE player state, shared by all five feeds (ENG-1599, grown from
  // ENG-1063's failure hook): one playing `postId:videoIndex` feed-wide, the
  // pill map, and the mint. See the hook for why a copy per feed was the bug.
  const playback = useFeedPlayback();
  const resetPlayback = playback.reset;
  // Paging (ENG-1633) — the same shape as HorsePosts; see there.
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const generation = useRef(0);

  const fetchPage = useCallback(async (forCursor: string | null) => {
    if (forCursor && loadingRef.current) return;
    const gen = forCursor ? generation.current : ++generation.current;
    const cancelled = () => gen !== generation.current;
    // A failed page 1 is the error state; a 5xx / network failure on a LATER
    // page only stops paging — it must not blank the posts already on screen.
    const fail = () => (forCursor ? setHasMore(false) : setError(true));
    // A 402 (or a gated media batch) is different: the member lapsed, so it goes
    // to the gated/error state on ANY page and drops every held playback URL
    // (guardrail 3; the same as explore/following/saved). Never a silent end.
    const gated = () => {
      resetPlayback();
      setHasMore(false);
      setError(true);
    };
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
      const res = await apiFetch(`/api/trainers/${trainerId}/feed${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        if (!cancelled()) (res.status === 402 ? gated : fail)();
        return;
      }
      const body = await res.json();
      const rows = (body.data ?? []) as PostRow[];
      const meta = (body.meta ?? {}) as { nextCursor?: string | null; hasMore?: boolean };
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
      // ONE batch call for the whole page's horse photos — never per card.
      const horsePhotos = await signPhotoMap(
        sb,
        HORSE_PHOTO_BUCKET,
        rows.map((r) => one(r.horse)?.photo_url),
      );
      // Photos, slide counts AND slot-0 video posters via ONE POST /api/posts/media
      // (ENG-1633; posterOnly only where the batch had none). Absolute URLs pass through. A 402 surfaces the
      // AccessWall (guardrail 3). `slideCounts` rides in on the same batch, which
      // is what lets a carousel draw the right dots before it mints a thing.
      let media: PostDisplayMedia;
      try {
        media = await resolvePostDisplayUrls(rows);
      } catch (e) {
        if (e instanceof PostMediaError && e.reason === "gated") {
          if (!cancelled()) gated();
          return;
        }
        media = { urls: new Map(), slideCounts: new Map() };
      }

      const intrinsics = { signedMedia: media.urls, slideCountByPost: media.slideCounts, reactionByPost: myReaction };
      const mapped: FeedPost[] = rows.map((r) => {
        const horse = one(r.horse);
        // The two-sided fallback below is HORSE-subject only (ticket decision
        // 6): a trainer- or StablePass-subject row gets "" rather than the old
        // "Horse" placeholder heading, since neither card draws a horse name.
        const subject = postSubjectOf(r);
        const horsePhotoUrl = horse?.photo_url ? horsePhotos.get(horse.photo_url) ?? null : null;
        const horseName =
          subject === "horse"
            ? // Formatted per side of the `||` so a racing_name of just "(AUS)"
              // falls through (ENG-761 item 6). Without this the trainer profile
              // shows two spellings of one horse: the formatted name in the
              // stable-horses list above, the raw registrar caps on these cards.
              horse
              ? displayHorseNameOrEmpty(horse.racing_name) || displayHorseNameOrEmpty(horse.display_name) || "Horse"
              : "Horse"
            : "";
        return {
          ...postIntrinsics(r, intrinsics),
          subject,
          byline: r.byline ?? null,
          horseId: r.horse_id ?? null,
          horseName,
          trainerName,
          trainerId,
          stableName,
          stableLocation,
          horsePhotoUrl,
          trainerPhotoUrl,
          head: buildPostHead({
            subject,
            horseName,
            horsePhotoUrl,
            trainerId,
            trainerName,
            stableName,
            stableLocation,
            trainerPhotoUrl,
            byline: r.byline ?? null,
          }),
          bookmarked: mySet.has(r.id),
        };
      });
      if (!cancelled()) {
        setPosts((prev) => (forCursor ? [...prev, ...mapped] : mapped));
        commitPaging();
      }
    } catch {
      // Network failure (fetch threw): page 1 → error, a later page → stop paging.
      if (!cancelled()) fail();
    } finally {
      if (!cancelled()) {
        loadingRef.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [trainerId, trainerName, stableName, stableLocation, trainerPhotoUrl, resetPlayback]);

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
    return <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load this stable&rsquo;s updates.</p>;
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
