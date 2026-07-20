"use client";

// ExploreFeed — the Explore screen (06-explore.html). Composes the W4 shared
// components (PostCard/ReactionBar/RaceDayBand/TrainerCard) against the W5 BFF
// (`/api/feed`, `/api/feed/seen`, `/api/posts/:id/playback`). The followed feed now
// lives on the dedicated /following screen (W13), so Explore is a single view.
//
// DATA REALITY: the be `feed` fn returns bare `post` rows (no horse/trainer names),
// so every page is enriched client-side: a `horse` lookup for the byline, plus the
// viewer's own `reaction`/`bookmark` rows (RLS returns only the viewer's own).
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { PostCard } from "@/components/post-card";
import { ReactionBar } from "@/components/reaction-bar";
import { RaceDayBand } from "@/components/race-day-band";
import { TrainerCard } from "@/components/trainer-card";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { FeedPost, PostMedia, ReactionEmoji, RaceDayEntry, TrainerSummary } from "@/components/types";

const LIMIT = 10;

// Bare be `post` row shape (no horse/trainer names — see module comment).
type PostRow = {
  id: string;
  horse_id: string;
  type: PostMedia["type"];
  body: string | null;
  media_url: string | null;
  watermarked: boolean;
  like_count: number;
  published_at: string;
};

type HorseTrainer = { name: string };
type HorseRow = { id: string; display_name: string; trainer: HorseTrainer | HorseTrainer[] | null };
type ReactionRow = { post_id: string; emoji: ReactionEmoji };
type BookmarkRow = { post_id: string };

type FollowTrainer = { id: string; name: string };
type FollowRow = { trainer: FollowTrainer | FollowTrainer[] | null };

const Search = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);
const Bell = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </svg>
);

export function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function ExploreFeed({ viewerId }: { viewerId: string }) {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [gated, setGated] = useState(false);
  const [races, setRaces] = useState<RaceDayEntry[]>([]);
  const [trainers, setTrainers] = useState<TrainerSummary[]>([]);
  const [playing, setPlaying] = useState<Record<string, string>>({});
  const [playError, setPlayError] = useState<Record<string, boolean>>({});

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const fetchPage = useCallback(async (forCursor: string | null) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(false);
    if (!forCursor) {
      // First page (initial mount) — reset list/gate/playing state.
      setPosts([]);
      setGated(false);
      setPlaying({});
      setPlayError({});
    }
    try {
      const params = new URLSearchParams({ limit: String(LIMIT) });
      if (forCursor) params.set("cursor", forCursor);

      const res = await fetch(`/api/feed?${params}`);
      if (res.status === 402) {
        setGated(true);
        return;
      }
      if (!res.ok) {
        setError(true);
        return;
      }

      const body = await res.json();
      const rows = (body.data ?? []) as PostRow[];
      const meta = (body.meta ?? {}) as { nextCursor?: string | null; hasMore?: boolean };

      if (rows.length === 0) {
        setCursor(meta.nextCursor ?? null);
        setHasMore(Boolean(meta.hasMore));
        return;
      }

      const ids = rows.map((r) => r.id);
      const horseIds = [...new Set(rows.map((r) => r.horse_id))];
      const sb = supabaseBrowser();

      const [{ data: horseRows }, { data: reactionRows }, { data: bookmarkRows }] = await Promise.all([
        sb.from("horse").select("id, display_name, trainer:trainer_id(name)").in("id", horseIds),
        sb.from("reaction").select("post_id,emoji").in("post_id", ids),
        sb.from("bookmark").select("post_id").in("post_id", ids),
      ]);

      const horseById = new Map(((horseRows ?? []) as HorseRow[]).map((h) => [h.id, h]));
      const myReaction = new Map(((reactionRows ?? []) as ReactionRow[]).map((r) => [r.post_id, r.emoji]));
      const mySet = new Set(((bookmarkRows ?? []) as BookmarkRow[]).map((b) => b.post_id));

      const mapped: FeedPost[] = rows.map((r) => {
        const horse = horseById.get(r.horse_id);
        const trainer = one(horse?.trainer ?? null);
        return {
          id: r.id,
          horseId: r.horse_id,
          horseName: horse?.display_name ?? "Unknown horse",
          trainerName: trainer?.name ?? "Stablepass",
          postedAgo: relativeTime(r.published_at),
          body: r.body,
          media: { type: r.type, posterUrl: r.media_url ?? null, duration: null },
          watermarked: r.watermarked,
          count: r.like_count,
          reacted: myReaction.get(r.id) ?? null,
          bookmarked: mySet.has(r.id),
        };
      });

      setPosts((prev) => (forCursor ? [...prev, ...mapped] : mapped));
      setCursor(meta.nextCursor ?? null);
      setHasMore(Boolean(meta.hasMore));

      // Best-effort impression tracking — never blocks rendering on failure.
      fetch("/api/feed/seen", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ postIds: ids }),
      }).catch(() => {});
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  // Fetch the first page on mount — a "synchronize with an external system"
  // effect (a data fetch), not derived render-state.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch, not derived state
    fetchPage(null);
  }, [fetchPage]);

  // Race-day band + "Trainers you follow" aside — loaded once, independent of the tab.
  useEffect(() => {
    const sb = supabaseBrowser();

    // Race-day band via the BFF (RF5): today's CONFIRMED runners among the horses
    // the viewer follows. This used to be a direct browser read of `race`, which
    // both ignored the viewer's follows and put a gated read outside the BFF.
    // A failure just leaves the band hidden — it must never break the feed.
    fetch("/api/race-day")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setRaces(((body?.data?.races ?? []) as RaceDayEntry[])))
      .catch(() => setRaces([]));

    (async () => {
      const { data: followRows } = await sb.from("follow").select("trainer:trainer_id(id,name)").not("trainer_id", "is", null);
      const trainerMap = new Map<string, string>();
      for (const row of (followRows ?? []) as FollowRow[]) {
        const t = one(row.trainer);
        if (t) trainerMap.set(t.id, t.name);
      }
      const trainerIds = [...trainerMap.keys()];
      if (trainerIds.length === 0) {
        setTrainers([]);
        return;
      }
      const { data: horseRows } = await sb.from("horse").select("trainer_id").in("trainer_id", trainerIds);
      const counts = new Map<string, number>();
      for (const h of (horseRows ?? []) as { trainer_id: string }[]) {
        counts.set(h.trainer_id, (counts.get(h.trainer_id) ?? 0) + 1);
      }
      setTrainers(trainerIds.map((id) => ({ id, name: trainerMap.get(id) ?? "", horseCount: counts.get(id) ?? 0 })));
    })();
  }, []);

  // Infinite scroll — a sentinel div at the bottom of the list loads the next page.
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

  const showEmpty = !gated && !error && !loading && posts.length === 0;
  const showSkeleton = !gated && !error && loading && posts.length === 0;

  return (
    <>
      <div className="topbar">
        <h1 className="section-title-web" style={{ margin: 0 }}>Explore</h1>
        <div className="topbar-spacer" />
        <div className="topbar-search">
          <Search /> Search horses, trainers…
        </div>
        <div className="topbar-bell" aria-hidden="true">
          <Bell />
        </div>
      </div>

      <div className="feed-grid">
        <div className="feed-col">
          {gated && (
            <div className="aside-card">
              <h3>Your trial has ended.</h3>
              <p style={{ color: "var(--muted)", marginBottom: 16 }}>
                Reactivate your subscription to keep up with the horses you follow.
              </p>
              <a className="btn btn-primary" href="/checkout">Reactivate</a>
            </div>
          )}

          {!gated && error && (
            <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load the feed.</p>
          )}

          {showSkeleton && (
            <>
              <div className="post-web" aria-hidden="true" style={{ height: 260, background: "var(--line)" }} />
              <div className="post-web" aria-hidden="true" style={{ height: 260, background: "var(--line)" }} />
            </>
          )}

          {showEmpty && (
            <p style={{ color: "var(--muted)", padding: "24px 0" }}>
              Nothing here yet — check back soon.
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
                          <div className="post-byline">
                            by <span className="by-trainer">{p.trainerName}</span> · {p.postedAgo}
                          </div>
                        </div>
                      </div>
                      <div className="post-media-web">
                        <video
                          controls
                          autoPlay
                          src={playbackUrl}
                          style={{ width: "100%", aspectRatio: "16/9", background: "#000" }}
                        />
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
                  <Fragment key={p.id}>
                    <PostCard
                      post={p}
                      viewerId={viewerId}
                      mediaAspect="wide"
                      onReact={(e) => react(p.id, e)}
                      onBookmark={() => bookmark(p.id)}
                      onPlay={() => play(p.id)}
                    />
                    {playError[p.id] && (
                      <p role="alert" style={{ color: "var(--red)", marginTop: -16, marginBottom: 24, fontSize: 13.5 }}>
                        Couldn&rsquo;t load the video.
                      </p>
                    )}
                  </Fragment>
                );
              })}
              <div ref={sentinelRef} />
            </>
          )}
        </div>

        <div className="feed-aside">
          <RaceDayBand races={races} />
          {trainers.length > 0 && (
            <div className="aside-card">
              <h3>Trainers you follow</h3>
              <div className="aside-trainer-list">
                {trainers.map((t) => (
                  <TrainerCard key={t.id} trainer={t} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
