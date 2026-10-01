"use client";

/**
 * use-feed-playback — the ONE player state the five member feeds share
 * (ENG-1599, grown out of ENG-1063's `use-feed-video-failure`).
 *
 * WHAT IT REPLACES. Each feed kept `playing: Record<postId, url>` and
 * `playError: Record<postId, boolean>` of its own, plus a verbatim copy of the
 * mint-and-play function. That allowed any number of videos to play at once and
 * could not address the second video of a post at all. This hook holds:
 *
 *   - ONE playing key for the whole feed — `postId:videoIndex` — so starting a
 *     video anywhere stops whichever one was playing (the player of the old key
 *     unmounts; a feed has no background audio to leave running);
 *   - the error map, keyed the same way.
 *
 * THE MINT. `GET /api/posts/:id/playback` (index 0, the exact url every feed
 * always used) or `?videoIndex=i` — the client names a post and an ordinal,
 * never an id or a path, and the minted url lives only in this component
 * state: it is never stored anywhere (guardrail 6). A 402 draws the existing
 * "Couldn't load the video." pill and NO video (guardrail 3): nothing is
 * rendered until the mint has answered 200.
 *
 * STALE ANSWERS. Two quick taps race two mints. Only the LATEST request may set
 * the playing key — a slow answer to the first tap must not start a second video
 * after the member has moved on (that is exactly the "two at once" this exists
 * to prevent).
 *
 * PRE-MINT (ENG-1633). `prefetch(postIds)` names the posts the member is about
 * to tap — the feed passes the card on screen and the one after it — and the
 * hook mints their playback urls AHEAD of the tap, so `play()` starts from a url
 * it already holds, with no request at all. The rules that keep that inside the
 * guardrails:
 *   - IN MEMORY ONLY (guardrail 6). The pre-minted urls live in a ref of this
 *     hook — never in state that renders, never in storage, never in the DOM.
 *     Nothing is rendered from one until a TAP picks it; still NO autoplay.
 *   - BOUNDED. `prefetch()` names the whole wanted set; every url outside it is
 *     dropped, so the feed holds at most two (plus the one playing).
 *   - SHORT-LIVED, AND TREATED SO. Each entry keeps the be's `expiresAt` (300 s)
 *     and is re-minted REMINT_MARGIN_MS before it lapses while it is still
 *     wanted — and the tab is VISIBLE: a hidden tab lets it lapse and re-mints
 *     the wanted set on return; `play()` never uses one inside that margin — it mints fresh, as it
 *     always did. The margin is two minutes, not seconds, because hls.js keeps
 *     fetching rendition playlists on the SAME token after the tap.
 *   - SILENT. A pre-mint that answers anything but 200 (402 included) stores
 *     nothing and raises NO pill: the tap then mints as before and owns the
 *     error UI. A lapsed member never reaches here anyway — the feeds render no
 *     card behind their wall.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { playbackPath } from "@/lib/api/post-media";
import type { FeedPost } from "@/components/types";

/** The feed-wide identity of ONE video: which post, which of its videos. */
export function playbackKey(postId: string, videoIndex = 0): string {
  return `${postId}:${videoIndex}`;
}

/**
 * A post that draws the VIDEO carousel rather than the single-video card: a
 * video post whose batch `videoCount` (ENG-1596) is above one. Lives here, not
 * in post-card, so the feeds and the card agree on it from one definition.
 */
export function isVideoCarouselPost(post: Pick<FeedPost, "media" | "videoCount">): boolean {
  return post.media.type === "video" && (post.videoCount ?? 1) > 1;
}

/**
 * A pre-minted url is re-minted this long before its `expiresAt`, and `play()`
 * will not start from one closer to expiry than this (ENG-1633).
 */
export const REMINT_MARGIN_MS = 120_000;

/** How a `play()` ended — the carousel reads it; the feeds ignore it. */
export type PlayOutcome = "playing" | "missing" | "failed" | "superseded";

export interface PlayOptions {
  /**
   * Called on a 404 INSTEAD of raising the error pill. The carousel passes it:
   * a 404 at an index means that video is not playable (still encoding after an
   * admin edit), so the slide is hidden rather than reported as broken.
   */
  onMissing?: () => void;
}

export interface FeedPlayback {
  /** The playing `postId:videoIndex`, or null. */
  playingKey: string | null;
  /** The minted url for this video iff it is the one playing. */
  urlFor(postId: string, videoIndex?: number): string | undefined;
  /**
   * The url the FEED renders its inline single-video player from — undefined for
   * a video-carousel post, whose player lives inside the carousel's own slide.
   */
  inlineUrl(post: FeedPost): string | undefined;
  /** Which of this post's videos is playing, or null. */
  playingIndex(postId: string): number | null;
  /** Does ANY video of this post carry the error pill? */
  failed(postId: string): boolean;
  play(postId: string, videoIndex?: number, opts?: PlayOptions): Promise<PlayOutcome>;
  /** Stop this video if it is the playing one, and void its mint if in flight. */
  stop(postId: string, videoIndex?: number): void;
  /**
   * Stop every OTHER video of this post — playing, or still minting. The
   * carousel calls it whenever the slide on screen changes, so swiping away
   * stops a playing slide AND a tap whose mint has not landed yet.
   */
  keepOnly(postId: string, videoIndex: number): void;
  /** A dead transport: unmount the player, raise the pill (ENG-1063's rule). */
  onFatal(postId: string, videoIndex?: number): void;
  /** A fresh first page: nothing playing, no pills, no pre-minted urls. */
  reset(): void;
  /**
   * Pre-mint (ENG-1633): these posts' playback urls, ahead of a tap — each at
   * the video its carousel is showing (`focus`), else video 0. REPLACES the
   * wanted set: every pre-minted url for a post not named here is dropped.
   */
  prefetch(postIds: string[]): void;
  /**
   * A video carousel's on-screen slide changed. If the post is in the wanted
   * set, the pre-mint follows the slide, so a tap on video 3 is instant too.
   */
  focus(postId: string, videoIndex: number): void;
}

type Playing = { key: string; url: string } | null;

/** One pre-minted url, held in memory only, with its be-issued expiry. */
type Minted = { url: string; expiresAt: number };

/** The tab is in the background — no pre-mint work is done for it (ENG-1633). */
function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Usable for a tap: known expiry, and more than the margin left on it. */
function isFresh(m: Minted | undefined, now = Date.now()): m is Minted {
  return m !== undefined && m.expiresAt - now > REMINT_MARGIN_MS;
}

/**
 * `{ playbackUrl, expiresAt }` off a 200 body, or null if either is unusable.
 *
 * `expiresAt` is SERVER time, and the member's clock can be minutes off. So it
 * is turned into a LOCAL deadline: the url's remaining lifetime as the server
 * saw it (`expiresAt` minus the response's `Date` header), added to our own
 * `Date.now()`. Comparing a server timestamp straight against a skewed client
 * clock made every url look already-expired, and the re-mint timer spin.
 * Without a usable `Date` header the server value is used as-is.
 */
function readMinted(body: unknown, res?: Pick<Response, "headers">): Minted | null {
  const data = (body as { data?: { playbackUrl?: unknown; expiresAt?: unknown } } | null)?.data;
  const url = data?.playbackUrl;
  const serverExpiry = typeof data?.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
  if (typeof url !== "string" || url.length === 0 || !Number.isFinite(serverExpiry)) return null;
  const serverNow = Date.parse(res?.headers?.get?.("date") ?? "");
  const expiresAt = Number.isFinite(serverNow) ? Date.now() + (serverExpiry - serverNow) : serverExpiry;
  return { url, expiresAt };
}

export function useFeedPlayback(): FeedPlayback {
  const [playing, setPlaying] = useState<Playing>(null);
  const [errors, setErrors] = useState<Record<string, true>>({});
  const seq = useRef(0);
  // The key whose mint is in flight — so `stop()` can void it (a swipe away
  // before the mint lands must not mount a player off screen).
  const inFlight = useRef<string | null>(null);

  // ── Pre-mint state (ENG-1633). Refs, not state: nothing renders from these. ──
  /** key -> pre-minted url. Only keys in `wanted` survive a `prefetch()`. */
  const minted = useRef(new Map<string, Minted>());
  /** key -> the pre-mint request in flight, so a tap can wait on it, not repeat it. */
  const pending = useRef(new Map<string, Promise<Minted | null>>());
  /** key -> its re-mint timer. */
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** The keys the feed currently wants pre-minted. */
  const wanted = useRef(new Set<string>());
  /** The post ids behind `wanted`, so `focus()` can recompute it. */
  const wantedPosts = useRef<string[]>([]);
  /** post id -> the video its carousel is showing. */
  const focused = useRef(new Map<string, number>());
  /** Keys whose pre-mint was refused this page — not retried until a tap. */
  const refused = useRef(new Set<string>());
  /** Bumped by reset(): a pre-mint that lands after it belongs to the old page. */
  const generation = useRef(0);

  const drop = useCallback((key: string) => {
    minted.current.delete(key);
    const t = timers.current.get(key);
    if (t !== undefined) clearTimeout(t);
    timers.current.delete(key);
  }, []);

  // The pre-mint's request: the url + expiry on a 200 that carries both, else
  // null. (The tap keeps its own request below — its 404/pill handling differs.)
  const mint = useCallback(async (postId: string, videoIndex: number) => {
    const res = await apiFetch(playbackPath(postId, videoIndex));
    if (res.status !== 200) return { status: res.status, minted: null as Minted | null };
    const body = await res.json().catch(() => null);
    return { status: 200, minted: readMinted(body, res) };
  }, []);

  // `premint` and its timer call each other; the ref breaks the cycle.
  const premintRef = useRef<(postId: string, videoIndex: number) => void>(() => {});

  const store = useCallback(
    (key: string, postId: string, videoIndex: number, m: Minted) => {
      drop(key);
      // Callers only store a url that is fresh (`isFresh`), so the re-mint is
      // always in the future — a url that arrives already inside the margin is
      // never kept, which is what stops a re-mint loop (not a timer floor).
      if (!isFresh(m)) return;
      minted.current.set(key, m);
      // Re-mint before it lapses — only while it is still wanted.
      const delay = m.expiresAt - Date.now() - REMINT_MARGIN_MS;
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          minted.current.delete(key);
          // A hidden tab re-mints nothing (a background tab would otherwise
          // mint every ~3 min for as long as it stays open). The url simply
          // lapses; `visibilitychange` re-mints the wanted set on return, and a
          // tap before that mints fresh, as `play()` always does for a stale one.
          if (isHidden()) return;
          if (wanted.current.has(key)) premintRef.current(postId, videoIndex);
        }, delay),
      );
    },
    [drop],
  );

  const premint = useCallback(
    (postId: string, videoIndex: number) => {
      const key = playbackKey(postId, videoIndex);
      if (isFresh(minted.current.get(key)) || pending.current.has(key) || refused.current.has(key)) return;
      const gen = generation.current;
      const run = async (): Promise<Minted | null> => {
        try {
          const r = await mint(postId, videoIndex);
          if (gen !== generation.current) return null;
          // Refused, unusable, or already inside the re-mint margin (a url that
          // short-lived is no use to a tap): keep nothing, and do not retry
          // until a tap — retrying would only mint the same thing again.
          if (!isFresh(r.minted ?? undefined)) {
            refused.current.add(key);
            return null;
          }
          if (wanted.current.has(key)) store(key, postId, videoIndex, r.minted!);
          return r.minted;
        } catch {
          return null;
        }
      };
      const p: Promise<Minted | null> = run().finally(() => {
        if (pending.current.get(key) === p) pending.current.delete(key);
      });
      pending.current.set(key, p);
    },
    [mint, store],
  );
  useEffect(() => {
    premintRef.current = premint;
  }, [premint]);

  const applyWanted = useCallback(
    (postIds: string[]) => {
      wantedPosts.current = postIds;
      const next = new Set(postIds.map((id) => playbackKey(id, focused.current.get(id) ?? 0)));
      wanted.current = next;
      for (const key of [...minted.current.keys()]) if (!next.has(key)) drop(key);
      for (const id of postIds) premint(id, focused.current.get(id) ?? 0);
    },
    [drop, premint],
  );

  const prefetch = useCallback((postIds: string[]) => applyWanted(postIds), [applyWanted]);

  // Back from a hidden tab: re-mint whatever is still wanted and was left to
  // lapse while hidden (`premint` skips a key that is still fresh or pending).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (isHidden()) return;
      for (const key of wanted.current) {
        const at = key.lastIndexOf(":");
        premint(key.slice(0, at), Number(key.slice(at + 1)));
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [premint]);

  const focus = useCallback(
    (postId: string, videoIndex: number) => {
      if (focused.current.get(postId) === videoIndex) return;
      focused.current.set(postId, videoIndex);
      if (wantedPosts.current.includes(postId)) applyWanted(wantedPosts.current);
    },
    [applyWanted],
  );

  // Unmount: no timer may outlive the feed — and no pre-mint still in flight
  // may land and arm a new one (it would re-mint every few minutes, forever,
  // against a feed that is gone). Bumping the generation makes it a no-op.
  useEffect(() => {
    const t = timers.current;
    const m = minted.current;
    const p = pending.current;
    return () => {
      generation.current += 1;
      wanted.current = new Set();
      wantedPosts.current = [];
      for (const id of t.values()) clearTimeout(id);
      t.clear();
      m.clear();
      p.clear();
    };
  }, []);

  const clearError = useCallback((key: string) => {
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const raise = useCallback((key: string) => {
    setErrors((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  }, []);

  const play = useCallback(
    async (postId: string, videoIndex = 0, opts?: PlayOptions): Promise<PlayOutcome> => {
      const key = playbackKey(postId, videoIndex);
      const mine = ++seq.current;
      inFlight.current = key;
      clearError(key);
      // Stop whatever else is playing NOW, at the tap — not when this mint
      // lands — so there is never a moment with two players running.
      setPlaying((prev) => (prev && prev.key !== key ? null : prev));
      try {
        // ENG-1633 — a url pre-minted for this video and not near expiry: start
        // from it, with NO request. A pre-mint still in flight is waited on
        // rather than repeated. Anything else mints at the tap, as it always did.
        let ready = minted.current.get(key);
        if (!isFresh(ready) && pending.current.has(key)) {
          const landed = await pending.current.get(key);
          if (mine !== seq.current) return "superseded";
          ready = landed ?? minted.current.get(key);
        }
        if (isFresh(ready)) {
          inFlight.current = null;
          setPlaying({ key, url: ready.url });
          return "playing";
        }
        const res = await apiFetch(playbackPath(postId, videoIndex));
        if (mine !== seq.current) return "superseded";
        if (res.status === 404 && opts?.onMissing) {
          opts.onMissing();
          return "missing";
        }
        if (res.status !== 200) {
          raise(key);
          return "failed";
        }
        const body = await res.json().catch(() => null);
        if (mine !== seq.current) return "superseded";
        const url = body?.data?.playbackUrl as string | undefined;
        if (!url) {
          raise(key);
          return "failed";
        }
        // A tap's own mint is kept like a pre-mint while the post is wanted, so
        // stopping and re-tapping within its lifetime costs nothing either.
        refused.current.delete(key);
        const m = readMinted(body, res);
        if (m && wanted.current.has(key)) store(key, postId, videoIndex, m);
        inFlight.current = null;
        setPlaying({ key, url });
        return "playing";
      } catch {
        if (mine !== seq.current) return "superseded";
        raise(key);
        return "failed";
      }
    },
    [clearError, raise, store],
  );

  const stop = useCallback((postId: string, videoIndex = 0) => {
    const key = playbackKey(postId, videoIndex);
    if (inFlight.current === key) {
      seq.current += 1; // its answer is now "superseded"
      inFlight.current = null;
    }
    setPlaying((prev) => (prev?.key === key ? null : prev));
  }, []);

  const keepOnly = useCallback((postId: string, videoIndex: number) => {
    const keep = playbackKey(postId, videoIndex);
    const prefix = `${postId}:`;
    const pendingKey = inFlight.current;
    if (pendingKey !== null && pendingKey.startsWith(prefix) && pendingKey !== keep) {
      seq.current += 1;
      inFlight.current = null;
    }
    setPlaying((prev) => (prev && prev.key.startsWith(prefix) && prev.key !== keep ? null : prev));
  }, []);

  const onFatal = useCallback(
    (postId: string, videoIndex = 0) => {
      // A dead transport must not leave a black rectangle: unmount the player
      // and raise the SAME pill a failed mint produces (ENG-1059 / ENG-1063).
      const key = playbackKey(postId, videoIndex);
      setPlaying((prev) => (prev?.key === key ? null : prev));
      raise(key);
    },
    [raise],
  );

  const reset = useCallback(() => {
    seq.current += 1; // any mint still in flight belongs to the old page
    inFlight.current = null;
    generation.current += 1; // …and so does any pre-mint
    for (const key of [...minted.current.keys()]) drop(key);
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
    pending.current.clear();
    wanted.current = new Set();
    wantedPosts.current = [];
    refused.current.clear();
    focused.current.clear();
    setPlaying(null);
    setErrors({});
  }, [drop]);

  return useMemo<FeedPlayback>(() => {
    const urlFor = (postId: string, videoIndex = 0) =>
      playing?.key === playbackKey(postId, videoIndex) ? playing.url : undefined;
    return {
      playingKey: playing?.key ?? null,
      urlFor,
      inlineUrl: (post) => (isVideoCarouselPost(post) ? undefined : urlFor(post.id, 0)),
      playingIndex: (postId) => {
        if (!playing) return null;
        const prefix = `${postId}:`;
        return playing.key.startsWith(prefix) ? Number(playing.key.slice(prefix.length)) : null;
      },
      failed: (postId) => Object.keys(errors).some((k) => k.startsWith(`${postId}:`)),
      play,
      stop,
      keepOnly,
      onFatal,
      reset,
      prefetch,
      focus,
    };
  }, [playing, errors, play, stop, keepOnly, onFatal, reset, prefetch, focus]);
}
