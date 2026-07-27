"use client";

// TrainerPosts — the trainer-profile "Recent updates" column (W8). Fetches this
// trainer's own published posts via the BFF (`/api/trainers/:id/feed` — a direct
// read, not the be feed fn), enriches with the viewer's own reaction/bookmark rows,
// and wires <PostCard>'s react/bookmark/play callbacks via supabaseBrowser. Unlike
// the horse version, a trainer's updates span their whole stable, so each post
// carries its OWN horse name for the byline. Mirrors W7 HorsePosts otherwise.
import { useEffect, useState } from "react";
import { PostCard } from "@/components/post-card";
import { ReactionBar } from "@/components/reaction-bar";
import { relativeTime } from "@/app/(member)/explore/explore-feed";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { FeedPost, PostMedia, ReactionEmoji } from "@/components/types";

type HorseRef = { display_name: string; racing_name: string | null };
type PostRow = {
  id: string;
  type: PostMedia["type"];
  body: string | null;
  media_url: string | null;
  watermarked: boolean;
  like_count: number;
  published_at: string;
  horse_id: string;
  horse: HorseRef | HorseRef[] | null;
};
type ReactionRow = { post_id: string; emoji: ReactionEmoji };
type BookmarkRow = { post_id: string };

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export interface TrainerPostsProps {
  trainerId: string;
  trainerName: string;
  viewerId: string;
}

export function TrainerPosts({ trainerId, trainerName, viewerId }: TrainerPostsProps) {
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
        const res = await fetch(`/api/trainers/${trainerId}/feed`);
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

        const mapped: FeedPost[] = rows.map((r) => {
          const horse = one(r.horse);
          return {
            id: r.id,
            horseId: r.horse_id,
            horseName: horse ? horse.racing_name || horse.display_name : "Horse",
            trainerName,
            postedAgo: relativeTime(r.published_at),
            body: r.body,
            media: { type: r.type, posterUrl: r.media_url ?? null, duration: null },
            watermarked: r.watermarked,
            count: r.like_count,
            reacted: myReaction.get(r.id) ?? null,
            bookmarked: mySet.has(r.id),
          };
        });
        if (!cancelled) setPosts(mapped);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [trainerId, trainerName]);

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
    return <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load this stable&rsquo;s updates.</p>;
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
                  <div className="post-byline">
                    by <span className="by-trainer">{p.trainerName}</span> · {p.postedAgo}
                  </div>
                </div>
              </div>
              <div className="post-media-web">
                <video controls autoPlay src={playbackUrl} style={{ width: "100%", aspectRatio: "16/9", background: "#000" }} />
              </div>
              {p.body && <div className="post-body-web">{p.body}</div>}
              <ReactionBar
                count={p.count}
                reacted={p.reacted}
                bookmarked={p.bookmarked}
                onReact={(e) => react(p.id, e)}
                onBookmark={() => bookmark(p.id)}
              />
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
