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

// Bare be `post` row shape (no horse/trainer names — see module comment).
// Pinned by test/explore-feed.test.tsx.
type PostRow = PostIntrinsicRow & { horse_id: string };

// `id` for the Follow pill (a name is not a key), `stable_name`/`location` for the
// STABLE UPDATE panel footer. Stable identity only — there is no owner field here
// and none may be added.
type HorseTrainer = { id: string; name: string; stable_name: string | null; location: string | null };
type HorseRow = { id: string; display_name: string; trainer: HorseTrainer | HorseTrainer[] | null };
type ReactionRow = { post_id: string; emoji: ReactionEmoji };
type BookmarkRow = { post_id: string };

type RaceHorse = { id: string; display_name: string };
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
// `trainer_id` is read RAW alongside the embed on purpose: the embed is what the
// aside needs (it wants the NAME), but a row whose trainer embed comes back null
// — RLS hid it, or the join missed — would silently drop that trainer from the
// followed set and put a Follow pill on a trainer the viewer already follows.
// The raw column cannot be hidden that way.
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

// `everSubscribed` is resolved SERVER-side (app/(member)/explore/page.tsx) and
// arrives as a boolean — `stripe_customer_id` itself never reaches client JS
// (.rx/guardrails.md #1). `gated` still comes from the BFF's 402, which is
// already date-aware via `hasAccess()`; ENG-585 only changes what the wall SAYS.
export function ExploreFeed({ viewerId, everSubscribed }: { viewerId: string; everSubscribed: boolean }) {
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [gated, setGated] = useState(false);
  const [races, setRaces] = useState<RaceDayEntry[]>([]);
  const [trainers, setTrainers] = useState<TrainerSummary[]>([]);
  // Which trainers the viewer already follows — the Follow pill's only input.
  // `null` means "not known yet", which is NOT the same as "follows nobody":
  // treating the two alike would flash a pill on every card and then retract the
  // ones that were wrong. Populated from the follow read this screen ALREADY
  // makes for the aside, so the pill costs no extra query and none per card.
  const [followedTrainerIds, setFollowedTrainerIds] = useState<Set<string> | null>(null);
  const [playing, setPlaying] = useState<Record<string, string>>({});
  const [playError, setPlayError] = useState<Record<string, boolean>>({});

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Trainer ids with a follow write in flight — see follow() below.
  const followInFlight = useRef<Set<string>>(new Set());
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
        // `sb` is untyped, so `tsc` can never catch a too-narrow `.select()`:
        // dropping a column here would silently blank the byline, the panel
        // footer or the Follow pill with no type error. Pinned by a test.
        sb.from("horse").select("id, display_name, trainer:trainer_id(id, name, stable_name, location)").in("id", horseIds),
        sb.from("reaction").select("post_id,emoji").in("post_id", ids),
        sb.from("bookmark").select("post_id").in("post_id", ids),
      ]);

      const horseById = new Map(((horseRows ?? []) as HorseRow[]).map((h) => [h.id, h]));
      const myReaction = new Map(((reactionRows ?? []) as ReactionRow[]).map((r) => [r.post_id, r.emoji]));
      const mySet = new Set(((bookmarkRows ?? []) as BookmarkRow[]).map((b) => b.post_id));
      // Photos + their slide counts via ONE POST /api/posts/media; video posters
      // via playback?posterOnly=1. Absolute URLs pass through. A 402 surfaces the
      // AccessWall (guardrail 3). `slideCounts` rides in on the same batch, which
      // is what lets a carousel draw the right dots before it mints a thing.
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
          // Title-cased and (AUS)-stripped for display; the raw value stays on
          // the row for keys and comparisons (ENG-761 item 6).
          horseName: displayHorseNameOrEmpty(horse?.display_name) || "Unknown horse",
          trainerName: trainer?.name ?? "Stablepass",
          trainerId: trainer?.id ?? null,
          stableName: trainer?.stable_name ?? null,
          stableLocation: trainer?.location ?? null,
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
    const today = new Date().toISOString().slice(0, 10);

    sb.from("race")
      .select("id, venue, race_number, race_class, distance_m, scheduled_at, race_horse(horse:horse_id(id, display_name))")
      .eq("race_date", today)
      .order("scheduled_at")
      .then(({ data }: { data: RaceRow[] | null }) => {
        const entries: RaceDayEntry[] = [];
        for (const r of data ?? []) {
          const runners = Array.isArray(r.race_horse) ? r.race_horse : r.race_horse ? [r.race_horse] : [];
          for (const runner of runners) {
            const horse = one(runner.horse);
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
      const rows = (followRows ?? []) as FollowRow[];
      const trainerMap = new Map<string, string>();
      for (const row of rows) {
        const t = one(row.trainer);
        if (t) trainerMap.set(t.id, t.name);
      }
      const trainerIds = [...trainerMap.keys()];

      // Set BEFORE the horse-count round trip below, and on the empty path too:
      // an empty follow list is a real answer (every card gets a pill), not a
      // reason to leave the state unknown.
      //
      // A FAILED read is the opposite: leaving it `null` keeps the pill hidden.
      // Treating an error as "follows nobody" would put a Follow pill on every
      // card INCLUDING trainers the viewer already follows, and clicking one
      // then writes a duplicate `follow` row the unique constraint rejects — the
      // pill flashes out and back. `null` means unknown; only a successful read
      // may answer the question.
      if (!followError) {
        setFollowedTrainerIds(
          new Set(rows.map((r) => r.trainer_id).filter((id): id is string => Boolean(id))),
        );
      }
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

  // Follow, from the pill on the media. Optimistic like react/bookmark above,
  // and it clears the pill on EVERY card by that trainer at once, which is the
  // reason follow state lives on the screen rather than inside the card.
  async function follow(trainerId: string) {
    // `follow_no_duplicate` is `unique (user_id, trainer_id, horse_id)`, and a
    // TRAINER follow has `horse_id IS NULL` — Postgres treats NULLs as distinct,
    // so that constraint does NOT stop a second row. A fast double-click before
    // the optimistic re-render would write two, and the Following rail would
    // then list the trainer twice with a duplicate React key.
    if (followInFlight.current.has(trainerId)) return;
    followInFlight.current.add(trainerId);

    setFollowedTrainerIds((prev) => new Set(prev ?? []).add(trainerId));

    const sb = supabaseBrowser();
    const { error: followError } = await sb.from("follow").insert({ user_id: viewerId, trainer_id: trainerId });
    followInFlight.current.delete(trainerId);

    // 23505 is unique_violation: the row already exists, so the viewer already
    // follows this trainer. That IS the desired end state — rolling back would
    // put the pill back on a trainer they follow, which is the bug, not the fix.
    if (followError && followError.code !== "23505") {
      setFollowedTrainerIds((prev) => {
        const next = new Set(prev ?? []);
        next.delete(trainerId);
        return next;
      });
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

  // No pill until the follow read has answered (see the state's comment), and
  // none for a trainer already followed — there is no "Following" variant.
  function canFollowTrainer(post: FeedPost): boolean {
    return followedTrainerIds !== null && Boolean(post.trainerId) && !followedTrainerIds.has(post.trainerId!);
  }

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
                          {/* title on a media card is withheld (client, 18 Aug 2026) — see post-card.tsx */}
                          <div className="post-byline">
                            <span className="by-trainer">{p.trainerName}</span> · {p.postedAgo}
                          </div>
                        </div>
                      </div>
                      <div {...mediaBoxProps(p.media.aspectRatio, { video: true })}>
                        <video
                          controls
                          autoPlay
                          src={playbackUrl}
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
                  <Fragment key={p.id}>
                    <PostCard
                      post={p}
                      viewerId={viewerId}
                      onReact={(e) => react(p.id, e)}
                      onBookmark={() => bookmark(p.id)}
                      onPlay={() => play(p.id)}
                      canFollow={canFollowTrainer(p)}
                      onFollow={() => p.trainerId && follow(p.trainerId)}
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
