"use client";

// SharesFeed — for-sale-horse posts only (ENG-831). Reuses the Explore layout
// (topbar + feed grid + race-day aside) but calls `/api/feed/shares` and renders
// PostCard with `variant="shares"` (no Follow; Contact-trainer CTA).
//
// needs-design-check: Explore mockup has no Shares screen; placement and card
// chrome match Explore minus follow + green contact CTA.
//
// DATA REALITY: same as Explore — bare `post` rows enriched client-side. Trainer
// `website_url` is selected here so the Contact CTA can open it (public only;
// never private contact rows, never PII, never prices).
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AccessWall } from "@/components/access-wall";
import { PostCard, mediaBoxProps } from "@/components/post-card";
import { ReactionBar } from "@/components/reaction-bar";
import { RaceDayBand } from "@/components/race-day-band";
import { TrainerCard } from "@/components/trainer-card";
import { supabaseBrowser } from "@/lib/supabase/client";
import { PostMediaError, resolvePostDisplayUrls, type PostDisplayMedia } from "@/lib/api/post-media";
import { postIntrinsics, type PostIntrinsicRow } from "@/lib/feed/post-row";
import type { FeedPost, ReactionEmoji, RaceDayEntry, TrainerSummary } from "@/components/types";
import { displayHorseNameOrEmpty } from "@/lib/format/horse-name";

const LIMIT = 10;

type PostRow = PostIntrinsicRow & { horse_id: string };

type HorseTrainer = {
  id: string;
  name: string;
  stable_name: string | null;
  location: string | null;
  website_url: string | null;
};
type HorseRow = { id: string; display_name: string; trainer: HorseTrainer | HorseTrainer[] | null };
type ReactionRow = { post_id: string; emoji: ReactionEmoji };
type BookmarkRow = { post_id: string };

type RaceHorse = { id: string; display_name: string; shares_for_sale?: boolean | null };
type RaceHorseRow = { horse: RaceHorse | RaceHorse[] | null };
type RaceRow = {
  id: string;
  venue: string | null;
  race_number: number | null;
  race_class: string | null;
  distance_m: number | null;
  scheduled_at: string | null;
  race_horse: RaceHorseRow[] | RaceHorseRow | null;
};

type FollowTrainer = { id: string; name: string };
type FollowRow = { trainer_id: string | null; trainer: FollowTrainer | FollowTrainer[] | null };

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

function formatClock(iso: string): string {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${h}:${String(m).padStart(2, "0")}${ampm}`;
}

function raceWhen(iso: string | null): string {
  if (!iso) return "Today";
  const diffMs = new Date(iso).getTime() - Date.now();
  const diffHours = Math.round(diffMs / 3_600_000);
  const rel = diffHours <= 0 ? "now" : diffHours === 1 ? "in 1 hour" : `in ${diffHours} hours`;
  return `Today · ${formatClock(iso)} · ${rel}`;
}

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export function SharesFeed({ viewerId, everSubscribed }: { viewerId: string; everSubscribed: boolean }) {
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
      setPosts([]);
      setGated(false);
      setPlaying({});
      setPlayError({});
    }
    try {
      const params = new URLSearchParams({ limit: String(LIMIT) });
      if (forCursor) params.set("cursor", forCursor);

      const res = await fetch(`/api/feed/shares?${params}`);
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
        // website_url for the Contact-trainer CTA — public column only.
        sb.from("horse").select("id, display_name, trainer:trainer_id(id, name, stable_name, location, website_url)").in("id", horseIds),
        sb.from("reaction").select("post_id,emoji").in("post_id", ids),
        sb.from("bookmark").select("post_id").in("post_id", ids),
      ]);

      const horseById = new Map(((horseRows ?? []) as HorseRow[]).map((h) => [h.id, h]));
      const myReaction = new Map(((reactionRows ?? []) as ReactionRow[]).map((r) => [r.post_id, r.emoji]));
      const mySet = new Set(((bookmarkRows ?? []) as BookmarkRow[]).map((b) => b.post_id));
      let media: PostDisplayMedia;
      try {
        media = await resolvePostDisplayUrls(rows);
      } catch (e) {
        if (e instanceof PostMediaError && e.reason === "gated") {
          setGated(true);
          return;
        }
        media = { urls: new Map(), slideCounts: new Map() };
      }

      const intrinsics = { signedMedia: media.urls, slideCountByPost: media.slideCounts, reactionByPost: myReaction };
      const mapped: FeedPost[] = rows.map((r) => {
        const horse = horseById.get(r.horse_id);
        const trainer = one(horse?.trainer ?? null);
        return {
          ...postIntrinsics(r, intrinsics),
          horseId: r.horse_id,
          horseName: displayHorseNameOrEmpty(horse?.display_name) || "Unknown horse",
          trainerName: trainer?.name ?? "Stablepass",
          trainerId: trainer?.id ?? null,
          websiteUrl: trainer?.website_url ?? null,
          stableName: trainer?.stable_name ?? null,
          stableLocation: trainer?.location ?? null,
          bookmarked: mySet.has(r.id),
        };
      });

      setPosts((prev) => (forCursor ? [...prev, ...mapped] : mapped));
      setCursor(meta.nextCursor ?? null);
      setHasMore(Boolean(meta.hasMore));

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

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch
    fetchPage(null);
  }, [fetchPage]);

  useEffect(() => {
    const sb = supabaseBrowser();
    const today = new Date().toISOString().slice(0, 10);

    sb.from("race")
      .select("id, venue, race_number, race_class, distance_m, scheduled_at, race_horse(horse:horse_id(id, display_name, shares_for_sale))")
      .eq("race_date", today)
      .order("scheduled_at")
      .then(({ data }: { data: RaceRow[] | null }) => {
        const entries: RaceDayEntry[] = [];
        for (const r of data ?? []) {
          const runners = Array.isArray(r.race_horse) ? r.race_horse : r.race_horse ? [r.race_horse] : [];
          for (const runner of runners) {
            const horse = one(runner.horse);
            // Shares surface: race-day can include for-sale runners (they are
            // the point of this feed). Explore filters them out separately.
            if (!horse) continue;
            entries.push({
              horseId: horse.id,
              horseName: displayHorseNameOrEmpty(horse.display_name),
              info: `${r.venue ?? "TBC"} R${r.race_number ?? "?"} · ${r.race_class ?? ""} · ${r.distance_m ?? "?"}m`,
              when: raceWhen(r.scheduled_at),
            });
          }
        }
        setRaces(entries);
      });

    (async () => {
      const { data: followRows, error: followError } = await sb
        .from("follow")
        .select("trainer_id, trainer:trainer_id(id,name)")
        .not("trainer_id", "is", null);
      if (followError) {
        setTrainers([]);
        return;
      }
      const rows = (followRows ?? []) as FollowRow[];
      const trainerMap = new Map<string, string>();
      for (const row of rows) {
        const t = one(row.trainer);
        if (t) trainerMap.set(t.id, t.name);
      }
      const trainerIds = [...trainerMap.keys()];
      if (trainerIds.length === 0) {
        setTrainers([]);
        return;
      }
      // Horse counts exclude for-sale horses (full segregation for browse-like UI).
      const { data: horseRows } = await sb
        .from("horse")
        .select("trainer_id, shares_for_sale")
        .in("trainer_id", trainerIds)
        .eq("shares_for_sale", false);
      const counts = new Map<string, number>();
      for (const h of (horseRows ?? []) as { trainer_id: string }[]) {
        counts.set(h.trainer_id, (counts.get(h.trainer_id) ?? 0) + 1);
      }
      setTrainers(trainerIds.map((id) => ({ id, name: trainerMap.get(id) ?? "", horseCount: counts.get(id) ?? 0 })));
    })();
  }, []);

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
        <h1 className="section-title-web" style={{ margin: 0 }}>Shares</h1>
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
          {gated && <AccessWall everSubscribed={everSubscribed} />}

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
                      {p.body && <div className="post-body-web">{p.body}</div>}
                    </article>
                  );
                }
                return (
                  <Fragment key={p.id}>
                    <PostCard
                      post={p}
                      viewerId={viewerId}
                      onReact={(e) => react(p.id, e)}
                      onBookmark={() => bookmark(p.id)}
                      onPlay={() => play(p.id)}
                      variant="shares"
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
