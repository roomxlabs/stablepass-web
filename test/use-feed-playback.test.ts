// ENG-1599 — the shared feed player's race rules, pinned at the hook level:
// a slow mint must never start a video the member has already moved on from.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFeedPlayback } from "@/lib/feed/use-feed-playback";

type Deferred = { url: string; resolve: (status: number) => void };

/** `fetch` whose answers the test releases by hand, in any order. */
function deferredFetch() {
  const pending: Deferred[] = [];
  const fn = vi.fn(
    (input: string | URL) =>
      new Promise((resolve) => {
        const url = String(input);
        pending.push({
          url,
          resolve: (status) =>
            resolve({
              ok: status === 200,
              status,
              json: async () => ({ data: { playbackUrl: `https://stream.test${url}.m3u8` } }),
            }),
        });
      }),
  );
  global.fetch = fn as unknown as typeof fetch;
  return pending;
}

afterEach(() => vi.restoreAllMocks());

describe("useFeedPlayback — stale mints never start a video", () => {
  it("two quick taps: the FIRST answer landing last is superseded, only the second plays", async () => {
    const pending = deferredFetch();
    const { result } = renderHook(() => useFeedPlayback());

    let first!: Promise<string>;
    let second!: Promise<string>;
    act(() => {
      first = result.current.play("a");
      second = result.current.play("b");
    });
    await act(async () => {
      pending[1].resolve(200);
      await second;
    });
    await act(async () => {
      pending[0].resolve(200);
      expect(await first).toBe("superseded");
    });
    expect(result.current.playingKey).toBe("b:0");
    expect(result.current.urlFor("a")).toBeUndefined();
  });

  it("stop() while the mint is in flight voids it — nothing mounts when it lands", async () => {
    const pending = deferredFetch();
    const { result } = renderHook(() => useFeedPlayback());
    let p!: Promise<string>;
    act(() => {
      p = result.current.play("v", 1);
    });
    expect(pending[0].url).toBe("/api/posts/v/playback?videoIndex=1");
    act(() => result.current.stop("v", 1));
    await act(async () => {
      pending[0].resolve(200);
      expect(await p).toBe("superseded");
    });
    expect(result.current.playingKey).toBeNull();
  });

  it("keepOnly(post, i) stops the post's OTHER slide (playing or minting), never another post's", async () => {
    const pending = deferredFetch();
    const { result } = renderHook(() => useFeedPlayback());
    let p!: Promise<string>;
    act(() => {
      p = result.current.play("v", 0);
    });
    await act(async () => {
      pending[0].resolve(200);
      await p;
    });
    expect(result.current.playingIndex("v")).toBe(0);

    // Keeping another post's slide leaves this one alone.
    act(() => result.current.keepOnly("other", 2));
    expect(result.current.playingIndex("v")).toBe(0);

    // Swiping this post to slide 1 stops slide 0.
    act(() => result.current.keepOnly("v", 1));
    expect(result.current.playingKey).toBeNull();

    // And a slide-2 mint still in flight is voided by keeping slide 1.
    act(() => {
      p = result.current.play("v", 2);
    });
    act(() => result.current.keepOnly("v", 1));
    await act(async () => {
      pending[1].resolve(200);
      expect(await p).toBe("superseded");
    });
    expect(result.current.playingKey).toBeNull();
  });

  it("a 404 with onMissing hides instead of raising the pill; without it, the pill is raised", async () => {
    const pending = deferredFetch();
    const { result } = renderHook(() => useFeedPlayback());
    const onMissing = vi.fn();
    let p!: Promise<string>;
    act(() => {
      p = result.current.play("v", 2, { onMissing });
    });
    await act(async () => {
      pending[0].resolve(404);
      expect(await p).toBe("missing");
    });
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(result.current.failed("v")).toBe(false);

    act(() => {
      p = result.current.play("s");
    });
    await act(async () => {
      pending[1].resolve(404);
      expect(await p).toBe("failed");
    });
    expect(result.current.failed("s")).toBe(true);
  });
});
