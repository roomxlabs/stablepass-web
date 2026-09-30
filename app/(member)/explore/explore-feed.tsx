"use client";

// ExploreFeed — the Explore screen (06-explore.html). Composes the W4 shared
// components (PostCard/ReactionBar/RaceDayBand/TrainerCard) against the W5 BFF
// (`/api/feed`, `/api/posts/media`, `/api/posts/:id/playback`). The followed feed now
// lives on the dedicated /following screen (W13), so Explore is a single view.
//
// DATA REALITY: the be `feed` fn returns bare `post` rows (no horse/trainer names),
// so every page is enriched: a `horse` lookup for the byline, plus the viewer's
// own `reaction`/`bookmark` rows (RLS returns only the viewer's own), plus the
// media mint — all four in parallel (`lib/feed/explore-page.ts`).
//
// PAGE 1 ARRIVES SERVER-RENDERED (ENG-1593): `initialPage` is the first page the
// server already assembled (or the wall, for a lapsed member), so this island
// does NOT fetch it again on mount. Only when the server could not build it
// (`null`) does the island fetch page 1 itself, exactly as it used to.
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessWall } from "@/components/access-wall";
import { HlsVideo } from "@/components/hls-video";
import { useFeedPlayback } from "@/lib/feed/use-feed-playback";
import { useFeedPrefetch } from "@/lib/feed/use-feed-prefetch";
import { PostCard, mediaBoxProps } from "@/components/post-card";
import { ReactionBar } from "@/components/reaction-bar";
import { RaceDayBand } from "@/components/race-day-band";
import { TrainerCard } from "@/components/trainer-card";
import { supabaseBrowser } from "@/lib/supabase/client";
// Still here for the ASIDE's trainer thumbs (ENG-1057) — the FEED's own photo
// signing moved into `lib/feed/subject.ts` at ENG-1270.
import { signPhotoMap, TRAINER_PHOTO_BUCKET } from "@/lib/storage/photos";
import { resolvePostDisplayUrls } from "@/lib/api/post-media";
import type { PostIntrinsicRow } from "@/lib/feed/post-row";
import { assembleExplorePage, EXPLORE_PAGE_SIZE, type ExploreInitialPage } from "@/lib/feed/explore-page";
import { PostHead } from "@/components/post-head";
import { MediaLoadPriority } from "@/components/post-media-image";
import type { FeedPost, ReactionEmoji, RaceDayEntry, TrainerSummary } from "@/components/types";
import { displayHorseNameOrEmpty } from "@/lib/format/horse-name";
import { apiFetch } from "@/lib/api/client";

const LIMIT = EXPLORE_PAGE_SIZE;

// Bare be `post` row shape (no horse/trainer names — see module comment).
// `horse_id` / `source_trainer_id` / `subject` / `byline` ride on the shared row
// type since ENG-1270. Pinned by test/explore-feed.test.tsx.
type PostRow = PostIntrinsicRow;

// The horse read, its trainer embed and both photo-signing batches MOVED to
// `lib/feed/subject.ts` at ENG-1270 — one helper for Explore, Following, Saved
// and the trainer profile, because a null `horse_id` inside `.in()` would
// otherwise blank every byline on the page (see that module's header). The
// reaction/bookmark reads and the media mint moved into
// `lib/feed/explore-page.ts` at ENG-1593, shared with the server render.

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

// `photo_url` since ENG-1057 — the aside row's thumb. A bare object path in the
// private `trainer-photos` bucket; it is signed below before it reaches a view
// model, never rendered as read.
type FollowTrainer = { id: string; name: string; photo_url: string | null };
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
export function ExploreFeed({
  viewerId,
  everSubscribed,
  initialPage = null,
}: {
  viewerId: string;
  everSubscribed: boolean;
  /** Page 1 as the server built it (ENG-1593); `null` → fetch it here, as before. */
  initialPage?: ExploreInitialPage | null;
}) {
  const seeded = initialPage?.kind === "ok" ? initialPage : null;
  const [posts, setPosts] = useState<FeedPost[]>(seeded?.posts ?? []);
  const [cursor, setCursor] = useState<string | null>(seeded?.nextCursor ?? null);
  const [hasMore, setHasMore] = useState(seeded?.hasMore ?? false);
  const [loading, setLoading] = useState(initialPage === null);
  const [error, setError] = useState(false);
  const [gated, setGated] = useState(initialPage?.kind === "gated");
  // Read once, on the first render: whether the server already handed us page 1.
  const [serverRendered] = useState(initialPage !== null);
  const [races, setRaces] = useState<RaceDayEntry[]>([]);
  const [trainers, setTrainers] = useState<TrainerSummary[]>([]);
  // Which trainers the viewer already follows — the Follow pill's only input.
  // `null` means "not known yet", which is NOT the same as "follows nobody":
  // treating the two alike would flash a pill on every card and then retract the
  // ones that were wrong. Populated from the follow read this screen ALREADY
  // makes for the aside, so the pill costs no extra query and none per card.
  const [followedTrainerIds, setFollowedTrainerIds] = useState<Set<string> | null>(null);
  // The ONE player state, shared by all five feeds (ENG-1599, grown from
  // ENG-1063's failure hook): one playing `postId:videoIndex` feed-wide, the
  // pill map, and the mint. See the hook for why a copy per feed was the bug.
  const playback = useFeedPlayback();
  const resetPlayback = playback.reset;

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
      resetPlayback();
    }
    try {
      const params = new URLSearchParams({ limit: String(LIMIT) });
      if (forCursor) params.set("cursor", forCursor);

      const res = await apiFetch(`/api/feed?${params}`);
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

      // Identity, reactions, bookmarks and the media mint all start TOGETHER
      // (ENG-1593) — the mint used to wait for the other three for no reason.
      const page = await assembleExplorePage(supabaseBrowser(), rows, (r) => resolvePostDisplayUrls(r));
      if (page.kind === "gated") {
        setGated(true);
        return;
      }
      if (page.kind === "error") {
        setError(true);
        return;
      }

      setPosts((prev) => (forCursor ? [...prev, ...page.posts] : page.posts));
      setCursor(meta.nextCursor ?? null);
      setHasMore(Boolean(meta.hasMore));
      // No `/api/feed/seen` call any more (ENG-1593). The be `feed` function
      // records the impressions for every UNSEEN row it serves, and the seen
      // top-up rows it serves already have one — so the second write here was
      // a guaranteed duplicate, and as a plain INSERT it failed on 23505 for
      // the whole batch every time.
    } catch {
      // A read that THREW (rather than returning an error) — a dead network or
      // an unexpected shape. The same error state as a failed feed fetch, never
      // a silent empty page; the server render maps the same case to its
      // client-fetch fallback.
      setError(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [resetPlayback]);

  // Fetch the first page on mount — a "synchronize with an external system"
  // effect (a data fetch), not derived render-state.
  // Skipped when the server already rendered page 1 (or the wall).
  useEffect(() => {
    if (serverRendered) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch, not derived state
    fetchPage(null);
  }, [fetchPage, serverRendered]);

  // Race-day band + "Trainers you follow" aside — loaded once, independent of the tab.
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
            // ENG-831: for-sale horses never appear on Explore (discovery segregation).
            if (!horse || horse.shares_for_sale) continue;
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
        .select("trainer_id, trainer:trainer_id(id,name,photo_url)")
        .not("trainer_id", "is", null);
      const rows = (followRows ?? []) as FollowRow[];
      // Holds the whole embed now, not just the name: the row needs the photo
      // path too, and keeping one map avoids a second keyed by the same ids.
      const trainerMap = new Map<string, FollowTrainer>();
      for (const row of rows) {
        const t = one(row.trainer);
        if (t) trainerMap.set(t.id, t);
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
      const { data: horseRows } = await sb
        .from("horse")
        .select("trainer_id")
        .in("trainer_id", trainerIds)
        // ENG-831: aside horse counts exclude for-sale horses.
        .eq("shares_for_sale", false);
      const counts = new Map<string, number>();
      for (const h of (horseRows ?? []) as { trainer_id: string }[]) {
        counts.set(h.trainer_id, (counts.get(h.trainer_id) ?? 0) + 1);
      }
      // ENG-1057 — the aside's thumbs, in the ONE batch this screen already runs
      // for the followed set (it is past the `trainerIds.length === 0` return,
      // so a member who follows nobody still makes no Storage call). Minted as
      // the viewer via `supabaseBrowser`; RLS `media gated read` is the boundary,
      // so a lapsed member gets an empty map and initials rather than URLs.
      const signed = await signPhotoMap(
        sb,
        TRAINER_PHOTO_BUCKET,
        trainerIds.map((id) => trainerMap.get(id)?.photo_url),
      );
      setTrainers(trainerIds.map((id) => {
        const t = trainerMap.get(id);
        return {
          id,
          name: t?.name ?? "",
          horseCount: counts.get(id) ?? 0,
          // `?? null` — the bare path is the INPUT to signing, never an output.
          photoUrl: t?.photo_url ? (signed.get(t.photo_url) ?? null) : null,
        };
      }));
    })();
  }, []);

  // Infinite scroll, EARLY (ENG-1633): page N+1 starts with <= 5 cards left
  // below the viewport (the sentinel is the fallback), one request per page;
  // the same observer pass pre-mints playback for the card on screen + the next.
  useFeedPrefetch({
    sentinelRef,
    posts,
    playback,
    canLoadMore: hasMore && !loading && !gated && !error,
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
              {posts.map((p, index) => {
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
                  // ENG-1593 — the FIRST card's image is the page's largest
                  // paint, so it is fetched eagerly at high priority; every card
                  // below it waits until it nears the viewport.
                  <MediaLoadPriority.Provider key={p.id} value={index === 0 ? "high" : "lazy"}>
                    <PostCard
                      post={p}
                      viewerId={viewerId}
                      onReact={(e) => react(p.id, e)}
                      onBookmark={() => bookmark(p.id)}
                      onPlay={() => void playback.play(p.id)}
                      playback={playback}
                      canFollow={canFollowTrainer(p)}
                      onFollow={() => p.trainerId && follow(p.trainerId)}
                    />
                    {playback.failed(p.id) && (
                      <p role="alert" style={{ color: "var(--red)", marginTop: -16, marginBottom: 24, fontSize: 13.5 }}>
                        Couldn&rsquo;t load the video.
                      </p>
                    )}
                  </MediaLoadPriority.Provider>
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
