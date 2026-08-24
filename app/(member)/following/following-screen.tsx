"use client";

// FollowingScreen — the Following hub (W13). Two "stories"-style avatar rails of the
// member's followed horses + trainers (newest-followed first; tap → profile), then the
// ranked Following feed (GET /api/feed/following) below. Mirrors explore-feed's
// fetch/enrich/engagement loop; reads the follow rails directly via supabaseBrowser
// (RLS follow_rw_self). The subscription gate comes from the feed route's 402, same as
// Explore. Unfollow is NOT here — it lives on the horse/trainer profiles.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ACCESS_COLUMNS, hasAccess, type AccessRow } from "@/lib/api/access";
import { AccessWall } from "@/components/access-wall";
import { PostCard, mediaBoxProps } from "@/components/post-card";
import { ReactionBar } from "@/components/reaction-bar";
import { supabaseBrowser } from "@/lib/supabase/client";
import { signPhotoMap, HORSE_PHOTO_BUCKET, TRAINER_PHOTO_BUCKET, POST_MEDIA_BUCKET } from "@/lib/storage/photos";
import { readPostPhotos } from "@/lib/post-media";
import { postIntrinsics, type PostIntrinsicRow } from "@/lib/feed/post-row";
import type { FeedPost, ReactionEmoji } from "@/components/types";
import { displayHorseNameOrEmpty } from "@/lib/format/horse-name";

const LIMIT = 10;

// Bare be `post` row shape (the following feed returns post rows; names are enriched).
// Pinned by test/following-screen.test.tsx.
type PostRow = PostIntrinsicRow & { horse_id: string };
// `id` for the Follow pill (a name is not a key), `stable_name`/`location` for the
// STABLE UPDATE panel footer. Stable identity only — no owner field, ever.
type HorseTrainer = { id: string; name: string; stable_name: string | null; location: string | null };
type HorseRow = { id: string; display_name: string; trainer: HorseTrainer | HorseTrainer[] | null };
type ReactionRow = { post_id: string; emoji: ReactionEmoji };
type BookmarkRow = { post_id: string };

// Followed-entity rows (rail data).
type FollowedHorse = { id: string; display_name: string; racing_name: string | null; photo_url: string | null };
type FollowedTrainer = { id: string; name: string; display_name: string | null; photo_url: string | null };
type HorseFollowRow = { created_at: string; horse: FollowedHorse | FollowedHorse[] | null };
type TrainerFollowRow = { created_at: string; trainer: FollowedTrainer | FollowedTrainer[] | null };
type RailItem = { id: string; name: string; photoUrl: string | null; href: string };

function one<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

// A circular "story"-style avatar (photo, or the initial-letter fallback) + name.
function Avatar({ item, onOpen }: { item: RailItem; onOpen: (href: string) => void }) {
  const initial = item.name[0]?.toUpperCase() ?? "?";
  return (
    <button
      type="button"
      onClick={() => onOpen(item.href)}
      aria-label={item.name}
      style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: 76, flexShrink: 0, background: "none", border: "none", padding: 0, cursor: "pointer" }}
    >
      <span
        aria-hidden="true"
        style={{ width: 64, height: 64, borderRadius: "50%", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, var(--brand-green-light), var(--brand-green-dark))", color: "var(--cream)", fontFamily: "var(--font-serif)", fontSize: 24, fontWeight: 600 }}
      >
        {item.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary Storage photo URL, cover-fit
          <img src={item.photoUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          initial
        )}
      </span>
      <span style={{ fontSize: 12, color: "var(--ink)", maxWidth: 76, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "center" }}>
        {item.name}
      </span>
    </button>
  );
}

// A horizontal-scroll rail of avatars; hidden entirely when it has no items.
function Rail({ title, items, onOpen }: { title: string; items: RailItem[]; onOpen: (href: string) => void }) {
  if (items.length === 0) return null;
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 className="section-title-web" style={{ fontSize: 15, margin: "0 0 12px" }}>{title}</h2>
      <div style={{ display: "flex", gap: 16, overflowX: "auto", paddingBottom: 4 }}>
        {items.map((it) => (
          <Avatar key={it.id} item={it} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

// `everSubscribed` — see the note in ../explore/explore-feed.tsx (server-resolved
// boolean; the Stripe id never reaches the browser).
export function FollowingScreen({ viewerId, everSubscribed }: { viewerId: string; everSubscribed: boolean }) {
  const router = useRouter();
  const [horses, setHorses] = useState<RailItem[]>([]);
  const [trainers, setTrainers] = useState<RailItem[]>([]);
  const [followsLoaded, setFollowsLoaded] = useState(false);
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [gated, setGated] = useState(false);
  const [playing, setPlaying] = useState<Record<string, string>>({});
  const [playError, setPlayError] = useState<Record<string, boolean>>({});

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  // Load the follow rails once (own follows via RLS `follow_rw_self`, newest first).
  useEffect(() => {
    const sb = supabaseBrowser();
    (async () => {
      // Content gate FIRST (mirrors SavedFeed/HorsesGrid) — don't read or render
      // follows before the subscription check resolves, so a lapsed member never
      // sees the rails flash before the reactivate prompt.
      const { data: sub } = await sb.from("subscription").select(ACCESS_COLUMNS).eq("user_id", viewerId).maybeSingle();
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
        setFollowsLoaded(true);
        return;
      }
      const [{ data: hRows }, { data: tRows }] = await Promise.all([
        sb.from("follow").select("created_at, horse:horse_id(id, display_name, racing_name, photo_url)").not("horse_id", "is", null).order("created_at", { ascending: false }),
        sb.from("follow").select("created_at, trainer:trainer_id(id, name, display_name, photo_url)").not("trainer_id", "is", null).order("created_at", { ascending: false }),
      ]);
      const followedHorses = ((hRows ?? []) as HorseFollowRow[])
        .map((r) => one(r.horse))
        .filter((h): h is FollowedHorse => h !== null);
      const followedTrainers = ((tRows ?? []) as TrainerFollowRow[])
        .map((r) => one(r.trainer))
        .filter((t): t is FollowedTrainer => t !== null);
      // Set as soon as the answer exists, before the photo-signing round trips.
      // Left `null` on the gated path above on purpose: a walled member is shown
      // no content, so there is nothing to offer a Follow pill on.
      //
      // A FAILED read must also leave it `null`, not empty. Treating an error as
      // "follows nobody" collapses the exact distinction this state exists to
      // preserve, and would offer Follow on trainers the viewer already follows.
      // `photo_url` is a bare path in a PRIVATE bucket — sign it or the avatar
      // renders as a broken relative URL. One batch call per bucket.
      const [horsePhotos, trainerPhotos] = await Promise.all([
        signPhotoMap(sb, HORSE_PHOTO_BUCKET, followedHorses.map((h) => h.photo_url)),
        signPhotoMap(sb, TRAINER_PHOTO_BUCKET, followedTrainers.map((t) => t.photo_url)),
      ]);

      const hItems: RailItem[] = followedHorses
        // Formatted per side of the `||`, not around it: a `racing_name` that is
        // nothing but "(AUS)" formats to "" and must then fall through to the
        // display name rather than rendering a blank row (ENG-761 item 6).
        .map((h) => ({ id: h.id, name: displayHorseNameOrEmpty(h.racing_name) || displayHorseNameOrEmpty(h.display_name), photoUrl: h.photo_url ? horsePhotos.get(h.photo_url) ?? null : null, href: `/horses/${h.id}` }));
      const tItems: RailItem[] = followedTrainers
        .map((t) => ({ id: t.id, name: t.display_name || t.name, photoUrl: t.photo_url ? trainerPhotos.get(t.photo_url) ?? null : null, href: `/trainers/${t.id}` }));
      setHorses(hItems);
      setTrainers(tItems);
      setFollowsLoaded(true);
    })();
  }, [viewerId]);

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

      const res = await fetch(`/api/feed/following?${params}`);
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
      setCursor(meta.nextCursor ?? null);
      setHasMore(Boolean(meta.hasMore));

      if (rows.length === 0) {
        if (!forCursor) setPosts([]);
        return;
      }

      const ids = rows.map((r) => r.id);
      const horseIds = [...new Set(rows.map((r) => r.horse_id))];
      const sb = supabaseBrowser();
      const [{ data: horseRows }, { data: reactionRows }, { data: bookmarkRows }] = await Promise.all([
        // `sb` is untyped, so `tsc` can never catch a too-narrow `.select()`.
        // Pinned by a test instead.
        sb.from("horse").select("id, display_name, trainer:trainer_id(id, name, stable_name, location)").in("id", horseIds),
        sb.from("reaction").select("post_id,emoji").in("post_id", ids),
        sb.from("bookmark").select("post_id").in("post_id", ids),
      ]);

      const horseById = new Map(((horseRows ?? []) as HorseRow[]).map((h) => [h.id, h]));
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

      // Best-effort impression tracking (the following feed is unseen-first).
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data fetch, not derived state
    fetchPage(null);
  }, [fetchPage]);

  // Infinite scroll.
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
    if (reactError) setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, reacted: prevReacted } : p)));
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
    if (bookmarkError) setPosts((prev) => prev.map((p) => (p.id === postId ? { ...p, bookmarked: prevBookmarked } : p)));
  }

  /**
   * ROUND 6 / ENG-761 item 4 — the Following screen offers NO Follow pill, ever.
   *
   * This is the whole point of the screen: everything in it is here BECAUSE the
   * viewer already follows it, so a "Follow" pill is either a no-op or, in the
   * edge cases where an unfollowed trainer's post is surfaced here, an offer
   * that contradicts the tab it is sitting in. Explore is where you follow
   * things; Following is where you read them.
   *
   * Deliberately still a function returning a constant, and deliberately NOT
   * unified with the identical-looking helper in `explore-feed.tsx`: the two
   * screens' pill behaviour is now different BY DESIGN, and the duplication is
   * what keeps them independently changeable. Merging them into a shared helper
   * would re-couple exactly what this ticket separated (locked open question,
   * ENG-761). If a third screen ever needs the Explore behaviour, copy Explore's.
   */
  function canFollowTrainer(): boolean {
    return false;
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

  const noFollows = followsLoaded && horses.length === 0 && trainers.length === 0;
  const showEmptyFeed = !gated && !error && !loading && posts.length === 0 && !noFollows;
  const showSkeleton = !gated && !error && loading && posts.length === 0;

  return (
    <div className="feed-grid" style={{ justifyContent: "center" }}>
      <div className="feed-col">
        <h1 className="section-title-web" style={{ marginBottom: 20 }}>Following</h1>

        {gated && <AccessWall everSubscribed={everSubscribed} />}

        {!gated && (
          <>
            {noFollows ? (
              <p style={{ color: "var(--muted)", padding: "8px 0 24px" }}>
                You&rsquo;re not following anyone yet.{" "}
                <a href="/explore" style={{ color: "var(--brand-green)", fontWeight: 600 }}>Explore</a>{" "}
                to find horses &amp; trainers to follow.
              </p>
            ) : (
              <>
                <Rail title="Horses" items={horses} onOpen={(href) => router.push(href)} />
                <Rail title="Trainers" items={trainers} onOpen={(href) => router.push(href)} />
              </>
            )}

            {error && (
              <p style={{ color: "var(--muted)", padding: "24px 0" }}>Couldn&rsquo;t load the feed.</p>
            )}

            {showSkeleton && (
              <>
                <div className="post-web" aria-hidden="true" style={{ height: 260, background: "var(--line)" }} />
                <div className="post-web" aria-hidden="true" style={{ height: 260, background: "var(--line)" }} />
              </>
            )}

            {showEmptyFeed && (
              <p style={{ color: "var(--muted)", padding: "24px 0" }}>Nothing from your follows yet.</p>
            )}

            {posts.length > 0 && (
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
                        <ReactionBar count={p.count} reacted={p.reacted} bookmarked={p.bookmarked} onReact={(e) => react(p.id, e)} onBookmark={() => bookmark(p.id)} />
                        {/* Caption below the reaction bar, same as PostCard. */}
                        {p.body && <div className="post-body-web">{p.body}</div>}
                      </article>
                    );
                  }
                  return (
                    <Fragment key={p.id}>
                      {/* `canFollowTrainer()` is a constant `false` (ENG-761
                          item 4), so no pill is ever drawn here. It is CALLED
                          rather than simply omitted so the decision is live
                          code a test can pin and a reader can find, instead of
                          an absence that looks like an oversight. `onFollow`
                          is deliberately not passed: there is nothing to
                          follow from, so this screen holds no follow-write
                          path at all. */}
                      <PostCard post={p} viewerId={viewerId} onReact={(e) => react(p.id, e)} onBookmark={() => bookmark(p.id)} onPlay={() => play(p.id)} canFollow={canFollowTrainer()} />
                      {playError[p.id] && (
                        <p role="alert" style={{ color: "var(--red)", marginTop: -16, marginBottom: 24, fontSize: 13.5 }}>Couldn&rsquo;t load the video.</p>
                      )}
                    </Fragment>
                  );
                })}
                <div ref={sentinelRef} />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
