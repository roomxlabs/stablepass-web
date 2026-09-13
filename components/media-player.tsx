"use client";

// media-player — inline video for a post's `.post-media-web` slot. Presentational
// except for the play affordance itself: on click it mints a signed Mux playback
// URL via the BFF (`POST /api/posts/:id/playback` — re-gated, W5) and swaps the
// poster for a <video>. No polling, no autoplay-on-mount.
//
// ENG-1056: that <video> is now `HlsVideo`, not a bare element. The minted URL is
// an HLS manifest, which only Safari/iOS can play natively — Chrome, Firefox and
// Edge need hls.js. The mint contract is untouched: `data.playbackUrl` is passed
// through verbatim and is the only URL ever loaded (guardrail 6).
//
// A TRANSPORT failure (dead stream, fatal hls.js error, refused `play()`) now
// lands in the same `status === "error"` state a failed MINT already did, so the
// member gets the poster plus the "Couldn't load video" pill instead of the
// black box with a forever-spinner they used to get.
import { useState } from "react";
import { PostMediaImage } from "./post-media-image";
import { HlsVideo } from "./hls-video";
import { apiFetch } from "@/lib/api/client";

const Play = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8Z" fill="currentColor" stroke="none" /></svg>
);

export interface MediaPlayerProps {
  postId: string;
  posterUrl?: string | null;
  duration?: string | null;
}

type Status = "idle" | "loading" | "error";

export function MediaPlayer({ postId, posterUrl, duration }: MediaPlayerProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);

  async function onPlay() {
    setStatus("loading");
    try {
      const res = await apiFetch(`/api/posts/${postId}/playback`, { method: "POST" });
      if (res.status !== 200) {
        setStatus("error");
        return;
      }
      const body = await res.json().catch(() => null);
      const url = body?.data?.playbackUrl as string | undefined;
      if (!url) {
        setStatus("error");
        return;
      }
      setPlaybackUrl(url);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  }

  // A transport failure clears the URL as well as setting the status: the
  // <video> must actually LEAVE the DOM, or the member keeps staring at the
  // black rectangle with a pill floating over it. Pressing Play again mints a
  // fresh short-lived URL, exactly as it always did.
  function onFatalError() {
    setPlaybackUrl(null);
    setStatus("error");
  }

  if (playbackUrl) {
    return (
      <div className="post-media-web">
        <HlsVideo
          src={playbackUrl}
          poster={posterUrl ?? undefined}
          controls
          playsInline
          onFatalError={onFatalError}
        />
      </div>
    );
  }

  return (
    <div className="post-media-web">
      <PostMediaImage postId={postId} src={posterUrl} video />
      <button
        className="media-play"
        type="button"
        aria-label="Play video"
        onClick={onPlay}
        disabled={status === "loading"}
      >
        <Play />
      </button>
      {duration && <div className="media-duration">{duration}</div>}
      {status === "error" && (
        <div
          role="alert"
          style={{
            position: "absolute",
            bottom: 14,
            right: 14,
            background: "rgba(0,0,0,0.6)",
            color: "#fff",
            fontSize: 11.5,
            padding: "4px 9px",
            borderRadius: 999,
          }}
        >
          Couldn&rsquo;t load video
        </div>
      )}
    </div>
  );
}
