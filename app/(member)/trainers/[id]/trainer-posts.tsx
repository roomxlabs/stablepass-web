"use client";

// TrainerPosts — the trainer-profile "Recent updates" column (W8). Fetches this
// trainer's own published posts via the BFF (`/api/trainers/:id/feed` — a direct
// read, not the be feed fn), enriches with the viewer's own reaction/bookmark rows,
// and wires <PostCard>'s react/bookmark/play callbacks via supabaseBrowser. Unlike
// the horse version, a trainer's updates span their whole stable, so each post
// carries its OWN horse name for the byline. Mirrors W7 HorsePosts otherwise.
import { useEffect, useState } from "react";
import { PostCard, PostAvatar, mediaBoxProps } from "@/components/post-card";
import { ReactionBar } from "@/components/reaction-bar";
import { supabaseBrowser } from "@/lib/supabase/client";
import { signPhotoMap, HORSE_PHOTO_BUCKET } from "@/lib/storage/photos";
import { PostMediaError, resolvePostDisplayUrls, type PostDisplayMedia } from "@/lib/api/post-media";
import { postIntrinsics, type PostIntrinsicRow } from "@/lib/feed/post-row";
import type { FeedPost, ReactionEmoji } from "@/components/types";
import { displayHorseNameOrEmpty } from "@/lib/format/horse-name";

// `photo_url` is a bare object path in the PRIVATE `horse-photos` bucket — this
// route is a plain BFF read (not a signing surface), so the SCREEN batch-signs
// it client-side with `signPhotoMap`, same rule as every other feed mapper (ENG-958).
type HorseRef = { display_name: string; racing_name: string | null; photo_url: string | null };
type PostRow = PostIntrinsicRow & { horse_id: string; horse: HorseRef | HorseRef[] | null };
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
        // ONE batch call for the whole page's horse photos — never per card.
        const horsePhotos = await signPhotoMap(
          sb,
          HORSE_PHOTO_BUCKET,
          rows.map((r) => one(r.horse)?.photo_url),
        );
        // Photos + their slide counts via ONE POST /api/posts/media; video posters
        // via playback?posterOnly=1. Absolute URLs pass through. A 402 surfaces the
        // AccessWall (guardrail 3). `slideCounts` rides in on the same batch, which
        // is what lets a carousel draw the right dots before it mints a thing.
        let media: PostDisplayMedia;
        try {
          media = await resolvePostDisplayUrls(rows);
        } catch (e) {
          if (e instanceof PostMediaError && e.reason === "gated") {
            if (!cancelled) setError(true);
            return;
          }
          media = { urls: new Map(), slideCounts: new Map() };
        }

        const intrinsics = { signedMedia: media.urls, slideCountByPost: media.slideCounts, reactionByPost: myReaction };
        const mapped: FeedPost[] = rows.map((r) => {
          const horse = one(r.horse);
          return {
            ...postIntrinsics(r, intrinsics),
            horseId: r.horse_id,
            // Formatted per side of the `||` so a racing_name of just "(AUS)"
            // falls through (ENG-761 item 6). Without this the trainer profile
            // shows two spellings of one horse: the formatted name in the
            // stable-horses list above, the raw registrar caps on these cards.
            horseName: horse
              ? displayHorseNameOrEmpty(horse.racing_name) || displayHorseNameOrEmpty(horse.display_name) || "Horse"
              : "Horse",
            trainerName,
            stableName,
            stableLocation,
            horsePhotoUrl: horse?.photo_url ? horsePhotos.get(horse.photo_url) ?? null : null,
            trainerPhotoUrl,
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
  }, [trainerId, trainerName, stableName, stableLocation, trainerPhotoUrl]);

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
