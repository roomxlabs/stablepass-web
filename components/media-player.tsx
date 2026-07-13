"use client";

// media-player — inline video for a post's `.post-media-web` slot. Presentational
// except for the play affordance itself: on click it mints a signed Mux playback
// URL via the BFF (`POST /api/posts/:id/playback` — re-gated, W5) and swaps the
// poster for a native <video>. No polling, no autoplay-on-mount.
import { useState } from "react";

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
      const res = await fetch(`/api/posts/${postId}/playback`, { method: "POST" });
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

  if (playbackUrl) {
    return (
      <div className="post-media-web">
        <video controls autoPlay src={playbackUrl} />
      </div>
    );
  }

  return (
    <div className="post-media-web">
      {posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={posterUrl} alt="" />
      ) : (
        <div style={{ width: "100%", height: "100%" }} />
      )}
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
