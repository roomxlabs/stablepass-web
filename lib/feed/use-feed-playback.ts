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
 */
import { useCallback, useMemo, useRef, useState } from "react";
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
  /** Stop this video if it is the playing one (a swipe away, an auto-advance block). */
  stop(postId: string, videoIndex?: number): void;
  /** A dead transport: unmount the player, raise the pill (ENG-1063's rule). */
  onFatal(postId: string, videoIndex?: number): void;
  /** A fresh first page: nothing playing, no pills. */
  reset(): void;
}

type Playing = { key: string; url: string } | null;

export function useFeedPlayback(): FeedPlayback {
  const [playing, setPlaying] = useState<Playing>(null);
  const [errors, setErrors] = useState<Record<string, true>>({});
  const seq = useRef(0);

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
      clearError(key);
      // Stop whatever else is playing NOW, at the tap — not when this mint
      // lands — so there is never a moment with two players running.
      setPlaying((prev) => (prev && prev.key !== key ? null : prev));
      try {
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
        setPlaying({ key, url });
        return "playing";
      } catch {
        if (mine !== seq.current) return "superseded";
        raise(key);
        return "failed";
      }
    },
    [clearError, raise],
  );

  const stop = useCallback((postId: string, videoIndex = 0) => {
    const key = playbackKey(postId, videoIndex);
    setPlaying((prev) => (prev?.key === key ? null : prev));
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
    setPlaying(null);
    setErrors({});
  }, []);

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
      onFatal,
      reset,
    };
  }, [playing, errors, play, stop, onFatal, reset]);
}
