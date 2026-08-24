"use client";

// HorsePosts — the horse-profile "Recent updates" column (07-horse-profile.html).
// Fetches this horse's own published posts via the BFF (`/api/horses/:id/feed` —
// a direct read, not the be feed fn), enriches with the viewer's own
// reaction/bookmark rows, and wires <PostCard>'s react/bookmark/play callbacks
// via supabaseBrowser — the same fetch/enrich/mutate shape as W6 explore-feed,
// scoped to one horse and without tabs/paging.
import { useEffect, useState } from "react";
import { PostCard, mediaBoxProps } from "@/components/post-card";
import { ReactionBar } from "@/components/reaction-bar";
import { supabaseBrowser } from "@/lib/supabase/client";
import { signPhotoMap, POST_MEDIA_BUCKET } from "@/lib/storage/photos";
import { readPostPhotos } from "@/lib/post-media";
import { postIntrinsics, type PostIntrinsicRow } from "@/lib/feed/post-row";
import type { FeedPost, ReactionEmoji } from "@/components/types";

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
  viewerId: string;
}

export function HorsePosts({ horseId, horseName, trainerName, stableName = null, stableLocation = null, viewerId }: HorsePostsProps) {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState<Record<string, string>>({});
  const [playError, setPlayError] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(false);
      try {
        const res = await fetch(`/api/horses/${horseId}/feed`);
        if (!res.ok) {
          if (!cancelled) setError(true);
          return;
        }
        const body = await res.json();
        const rows = (body.data ?? []) as PostRow[];
        if (rows.length === 0) {
          if (!cancelled) setPosts([]);
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
        // `media_url` is a bare path in the PRIVATE `post-media` bucket — sign it
        // or the poster renders as a broken relative URL (absolute URLs pass through).
        // Concurrent, not sequential: the carousel read is independent of the
        // poster signing, so it costs no extra latency on the feed.
        const [postMedia, photosByPost] = await Promise.all([
          signPhotoMap(sb, POST_MEDIA_BUCKET, rows.flatMap((r) => [r.poster_url, r.media_url])),
          readPostPhotos(sb, rows.map((r) => r.id)),
        ]);

        const intrinsics = { signedMedia: postMedia, photosByPost, reactionByPost: myReaction };
        const mapped: FeedPost[] = rows.map((r) => ({
          ...postIntrinsics(r, intrinsics),
          horseId,
          horseName,
          trainerName,
          stableName,
          stableLocation,
          bookmarked: mySet.has(r.id),
        }));
        if (!cancelled) setPosts(mapped);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [horseId, horseName, trainerName, stableName, stableLocation]);

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

  async function play(postId: string) {
    setPlayError((prev) => ({ ...prev, [postId]: false }));
    try {
      const res = await fetch(`/api/posts/${postId}/playback`);
      if (res.status !== 200) {
        setPlayError((prev) => ({ ...prev, [postId]: true }));
        return;
      }
      const body = await res.json().catch(() => null);
      const url = body?.data?.playbackUrl as string | undefined;
      if (!url) {
        setPlayError((prev) => ({ ...prev, [postId]: true }));
        return;
      }
      setPlaying((prev) => ({ ...prev, [postId]: url }));
    } catch {
      setPlayError((prev) => ({ ...prev, [postId]: true }));
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
  );
}
