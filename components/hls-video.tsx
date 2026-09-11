"use client";

// hls-video — the <video> that can actually PLAY the Mux signed HLS stream the BFF
// mints (an `.m3u8` manifest URL carrying a short-lived token) in every browser, not
// just Safari.
//
// WHY THIS EXISTS (ENG-1056). `media-player` used to hand the minted URL to a
// bare `<video src>`. Safari/iOS play HLS natively; Chrome, Firefox and Edge do
// not. Firefox reports `canPlayType("application/vnd.apple.mpegurl") === ""` and
// fails the element with `MediaError code 4 "Failed to open media"` — and with
// no `onError` anywhere, the member sat on a black box with a spinner forever.
// Verified in production 10 Sep 2026: the mint was 200 and Mux served the
// manifest 200 — the transport was the whole bug.
//
// This is a port of the admin app's `app/(dash)/compose/HlsVideo.tsx`, which
// solved the same problem, plus the two things a MEMBER-facing player needs
// that the compose preview did not:
//
//   1. an explicit `play()` (see `startPlayback` below), because the mount here
//      is click-initiated and the `autoPlay` ATTRIBUTE alone is not honoured as
//      user-initiated by Safari on a freshly-mounted element; and
//   2. `onFatalError`, so a dead stream degrades to the poster + the existing
//      "Couldn't load video" pill instead of a silent black rectangle.
//
// GUARDRAIL 6 — the only URL this component ever loads is the `src` prop, which
// `media-player` takes verbatim from `data.playbackUrl` of
// `POST /api/posts/:id/playback`. No Mux host literal (not even in a comment — the
// guardrail test greps this file), no playback id, no token construction, and nothing
// is ever logged (hls.js `debug: false`) — the signed URL must not reach the console
// (guardrail 1).
//
// hls.js is imported LAZILY. Explore renders many cards and most sessions never
// press Play; the chunk must not be paid for until it is needed.
import { useEffect, useRef } from "react";
import type { VideoHTMLAttributes } from "react";
import type Hls from "hls.js";

export interface HlsVideoProps extends Omit<VideoHTMLAttributes<HTMLVideoElement>, "src"> {
  /** The minted playback URL. Loaded verbatim — never rewritten (guardrail 6). */
  src: string;
  /**
   * A transport failure the member must be TOLD about — the parent unmounts this
   * element and draws the poster + pill. Deliberately narrow: only a FATAL
   * `Hls.Events.ERROR`, an element `error` on the native path, or a `play()`
   * rejection that is not the browser merely declining to autostart.
   *
   * What must NOT reach here, because each would replace a working stream with
   * an error: a non-fatal hls.js error (hls.js recovers from those itself), a
   * raw element `error` on the MSE path (hls.js owns classification there), and
   * a `NotAllowedError`/`AbortError` from `play()` (see `startPlayback`).
   */
  onFatalError?: () => void;
}

/** Is this an HLS manifest? The query string carries the Mux token, so strip it first. */
function isHlsSrc(src: string): boolean {
  return src.split("?")[0].endsWith(".m3u8");
}

export function HlsVideo({ src, onFatalError, ...rest }: HlsVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // The callback lives in a ref so the transport effect below keys on `src`
  // ALONE. Keyed on the callback as well, an inline arrow from the parent would
  // tear down hls.js and re-create it on every parent re-render — destroying a
  // playing stream mid-frame.
  const onFatalErrorRef = useRef(onFatalError);
  useEffect(() => {
    onFatalErrorRef.current = onFatalError;
  }, [onFatalError]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let hls: Hls | undefined;

    const fail = () => {
      if (cancelled) return;
      onFatalErrorRef.current?.();
    };

    /**
     * The explicit play.
     *
     * `play()` returns a promise, and a rejection is NOT automatically a broken
     * stream — two of them mean the stream is perfectly fine and the browser
     * simply declined to start it:
     *
     *   - `NotAllowedError` — autoplay refused. This is the ordinary Safari/iOS
     *     answer when the call lands outside the gesture's task, and Safari is
     *     the one browser that already worked before this ticket. Turning it
     *     into "Couldn't load video" would REGRESS the only working platform.
     *   - `AbortError` — the member hit pause (or a new load started) before the
     *     promise settled. One fast click, and a loading video would vanish.
     *
     * In both cases the honest state is what the element already shows: loaded,
     * paused, with its native `controls` — so leave it mounted. Anything else
     * (a decode failure, `NotSupportedError`) is a real transport failure and
     * goes to the pill. A rejection must never go UNHANDLED either — that is the
     * silent black box this ticket removes.
     */
    const startPlayback = () => {
      if (cancelled) return;
      void Promise.resolve(video.play()).catch((err: unknown) => {
        const name = err instanceof Error ? err.name : "";
        if (name === "NotAllowedError" || name === "AbortError") return;
        fail();
      });
    };

    // Native path: Safari/iOS (and anything else that claims HLS), plus any
    // non-HLS source. `loadedmetadata` is the earliest point the element is
    // ready to play; if the element beat us to it, play now rather than wait for
    // an event that has already fired.
    //
    // The element's own `error` event is wired HERE rather than as an `onError`
    // prop on the JSX, and only on this path, for two reasons: it must respect
    // `cancelled` (this is the one error route that can fire during teardown),
    // and on the hls.js path error classification belongs to hls.js — it
    // recovers from plenty of element-level errors itself, so treating a raw
    // `error` event there as fatal would tear down a stream that was about to
    // heal (the same reason non-fatal `Hls.Events.ERROR` is ignored below).
    // Set by `playNatively` alone. It is the teardown's proof that the ELEMENT
    // owns the load rather than hls.js, which decides whether the cleanup below
    // may release the source — the two paths need opposite treatment and both
    // returns can be reached after a native load (see `releaseNativeSource`).
    let loadedNatively = false;

    const playNatively = () => {
      loadedNatively = true;
      video.addEventListener("error", fail);
      video.src = src;
      if (video.readyState >= 1 /* HAVE_METADATA */) {
        startPlayback();
        return;
      }
      video.addEventListener("loadedmetadata", startPlayback, { once: true });
    };

    const detachNativeListeners = () => {
      video.removeEventListener("loadedmetadata", startPlayback);
      video.removeEventListener("error", fail);
    };

    /**
     * Release the media resource on the NATIVE path (ENG-1063).
     *
     * `hls.destroy()` tears down the MediaSource and aborts every in-flight
     * segment request for us — but only on the MSE path. On the native path
     * (Safari/iOS, and the `isSupported() === false` fallback) nothing does:
     * the element keeps its own fetch alive after React has unmounted it, so
     * scrolling a feed leaks one live download per card ever played. That is
     * the leak the cleanup's comment already claimed to cover and didn't.
     *
     * Dropping the attribute and re-running the load algorithm against an
     * element with no source is the spec's way to say "abandon it": the fetch
     * is aborted and `networkState` returns to `NETWORK_EMPTY`.
     *
     * Guarded, because it must NOT run on the MSE path — there `video.src` is
     * the blob: URL hls.js attached, and clearing it out from under
     * `destroy()` would be reaching into hls.js's own teardown.
     */
    const releaseNativeSource = () => {
      if (!loadedNatively) return;
      video.removeAttribute("src");
      video.load();
    };

    if (!isHlsSrc(src) || video.canPlayType("application/vnd.apple.mpegurl") !== "") {
      playNatively();
      return () => {
        cancelled = true;
        detachNativeListeners();
        releaseNativeSource();
      };
    }

    void import("hls.js")
      .then(({ default: HlsCtor }) => {
        if (cancelled) return;
        if (!HlsCtor.isSupported()) {
          // No MSE (an old browser, a locked-down webview). Let the element try
          // natively; if it cannot, its own `error` event lands on `fail`.
          playNatively();
          return;
        }
        // `debug: false` explicitly: hls.js's debug mode logs the manifest URL,
        // which carries the Mux token (guardrail 1).
        hls = new HlsCtor({ debug: false });
        hls.on(HlsCtor.Events.MANIFEST_PARSED, startPlayback);
        hls.on(HlsCtor.Events.ERROR, (_event, data) => {
          if (data.fatal) fail();
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      })
      .catch(fail);

    return () => {
      cancelled = true;
      // Attached only if the isSupported() fallback took the native path, but
      // removing a listener that was never added is a no-op.
      detachNativeListeners();
      // Likewise a no-op unless that fallback ran — on the MSE path taken
      // above, `destroy()` releases the source and this must not touch it.
      releaseNativeSource();
      // Destroys the MediaSource, aborts every in-flight segment request and
      // drops hls.js's own listeners. Without it, scrolling a feed leaks a
      // player (and its network activity) per card ever played.
      hls?.destroy();
    };
  }, [src]);

  return (
    // `{...rest}` FIRST, deliberately. `playsInline` is the iOS guarantee this
    // component exists to make, so a caller must not be able to switch it off by
    // accident — and nothing that carries the failure wiring lives in the JSX at
    // all any more (the element's `error` listener is attached in the effect),
    // so a caller's own `onError` can no longer silently replace it.
    <video {...rest} ref={videoRef} playsInline />
  );
}
