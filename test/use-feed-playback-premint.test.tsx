// ENG-1633 — the feed player's playback PRE-MINT: urls minted ahead of the tap,
// held in memory only, re-minted before expiry, never autoplayed, and silent on
// any refusal.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { REMINT_MARGIN_MS, useFeedPlayback } from "@/lib/feed/use-feed-playback";

const NOW = Date.parse("2026-09-30T00:00:00.000Z");

type Reply = { status?: number; expiresInMs?: number | null; url?: string };

/**
 * `fetch` answering every playback mint. `replies` is consulted per url, so a
 * test can refuse one post; each 200 carries a fresh url and an `expiresAt`.
 */
function mockPlaybackFetch(reply: (url: string, n: number) => Reply = () => ({})) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const r = reply(url, calls.length);
    const status = r.status ?? 200;
    const expiresInMs = r.expiresInMs === undefined ? 300_000 : r.expiresInMs;
    return {
      ok: status === 200,
      status,
      json: async () => ({
        data: {
          playbackUrl: r.url ?? `https://stream.test${url}#${calls.length}.m3u8`,
          ...(expiresInMs === null ? {} : { expiresAt: new Date(Date.now() + expiresInMs).toISOString() }),
        },
      }),
    };
  });
  global.fetch = fn as unknown as typeof fetch;
  return calls;
}

/** Let the pre-mint's promise chain settle (no timers involved). */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useFeedPlayback pre-mint — a tap starts from the url already held", () => {
  it("prefetch([id]) mints ONCE; play(id) then plays that url with no second request", async () => {
    const calls = mockPlaybackFetch();
    const { result } = renderHook(() => useFeedPlayback());

    act(() => result.current.prefetch(["a"]));
    await settle();
    expect(calls).toEqual(["/api/posts/a/playback"]);

    let outcome!: string;
    await act(async () => {
      outcome = await result.current.play("a");
    });
    expect(outcome).toBe("playing");
    expect(result.current.urlFor("a")).toBe("https://stream.test/api/posts/a/playback#1.m3u8");
    expect(calls).toHaveLength(1);
  });

  it("play() while the pre-mint is still in flight awaits it: ONE request in total", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: string | URL) => {
      calls.push(String(input));
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { playbackUrl: "https://stream.test/a.m3u8", expiresAt: new Date(Date.now() + 300_000).toISOString() },
        }),
      };
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useFeedPlayback());

    act(() => result.current.prefetch(["a"]));
    let p!: Promise<string>;
    act(() => {
      p = result.current.play("a");
    });
    expect(calls).toHaveLength(1);
    await act(async () => {
      release();
      expect(await p).toBe("playing");
    });
    expect(calls).toHaveLength(1);
    expect(result.current.urlFor("a")).toBe("https://stream.test/a.m3u8");
  });

  it("an entry only 60 s from expiry (inside the 120 s margin) is NOT used: play() mints fresh", async () => {
    expect(REMINT_MARGIN_MS).toBe(120_000);
    let first = true;
    const calls = mockPlaybackFetch(() => {
      const r = { expiresInMs: first ? 60_000 : 300_000 };
      first = false;
      return r;
    });
    const { result } = renderHook(() => useFeedPlayback());

    act(() => result.current.prefetch(["a"]));
    await settle();
    expect(calls).toHaveLength(1);

    await act(async () => {
      await result.current.play("a");
    });
    expect(calls).toEqual(["/api/posts/a/playback", "/api/posts/a/playback"]);
    expect(result.current.urlFor("a")).toBe("https://stream.test/api/posts/a/playback#2.m3u8");
  });

  it("a mint answering without an expiresAt is not trusted for the tap: play() mints its own", async () => {
    const calls = mockPlaybackFetch(() => ({ expiresInMs: null }));
    const { result } = renderHook(() => useFeedPlayback());
    act(() => result.current.prefetch(["a"]));
    await settle();
    await act(async () => {
      await result.current.play("a");
    });
    expect(calls).toHaveLength(2);
  });
});

describe("useFeedPlayback pre-mint — re-mint before expiry, only while wanted", () => {
  it("re-mints a still-wanted id ~181 s in (300 s expiry - 120 s margin); stops once unwanted", async () => {
    const calls = mockPlaybackFetch();
    const { result } = renderHook(() => useFeedPlayback());

    act(() => result.current.prefetch(["a"]));
    await settle();
    expect(calls).toHaveLength(1);

    // Not yet due at 170 s…
    await act(async () => {
      await vi.advanceTimersByTimeAsync(170_000);
    });
    expect(calls).toHaveLength(1);
    // …due by 181 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(calls).toEqual(["/api/posts/a/playback", "/api/posts/a/playback"]);

    act(() => result.current.prefetch([]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(calls).toHaveLength(2);
  });

  it("prefetch([a]) then prefetch([b]) drops a's entry: play(a) makes a NEW request", async () => {
    const calls = mockPlaybackFetch();
    const { result } = renderHook(() => useFeedPlayback());

    act(() => result.current.prefetch(["a"]));
    await settle();
    act(() => result.current.prefetch(["b"]));
    await settle();
    expect(calls).toEqual(["/api/posts/a/playback", "/api/posts/b/playback"]);

    await act(async () => {
      await result.current.play("a");
    });
    expect(calls).toEqual(["/api/posts/a/playback", "/api/posts/b/playback", "/api/posts/a/playback"]);
  });

  it("prefetch() with an id already held does not mint it again", async () => {
    const calls = mockPlaybackFetch();
    const { result } = renderHook(() => useFeedPlayback());
    act(() => result.current.prefetch(["a"]));
    await settle();
    act(() => result.current.prefetch(["a", "b"]));
    await settle();
    expect(calls).toEqual(["/api/posts/a/playback", "/api/posts/b/playback"]);
  });

  it("unmounting clears the re-mint timers", async () => {
    const calls = mockPlaybackFetch();
    const { result, unmount } = renderHook(() => useFeedPlayback());
    act(() => result.current.prefetch(["a"]));
    await settle();
    unmount();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls).toHaveLength(1);
  });

  it("a pre-mint still IN FLIGHT at unmount lands as a no-op: it arms no re-mint (1 request over an hour)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: string | URL) => {
      calls.push(String(input));
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { playbackUrl: "https://stream.test/a.m3u8", expiresAt: new Date(Date.now() + 300_000).toISOString() } }),
      };
    }) as unknown as typeof fetch;
    const { result, unmount } = renderHook(() => useFeedPlayback());
    act(() => result.current.prefetch(["a"]));
    await settle();
    unmount();
    release();
    await settle();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(calls).toHaveLength(1);
  });
});

describe("useFeedPlayback pre-mint — the member's clock is not the server's", () => {
  /** A 200 whose `expiresAt` + `Date` header come from a server clock `skewMs` BEHIND the client. */
  function mockSkewedFetch(skewMs: number) {
    const calls: string[] = [];
    global.fetch = vi.fn(async (input: string | URL) => {
      calls.push(String(input));
      const serverNow = Date.now() - skewMs;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ date: new Date(serverNow).toUTCString() }),
        json: async () => ({
          data: { playbackUrl: `https://stream.test/${calls.length}.m3u8`, expiresAt: new Date(serverNow + 300_000).toISOString() },
        }),
      };
    }) as unknown as typeof fetch;
    return calls;
  }

  it("a client clock 4 min AHEAD still gets a usable pre-mint, re-minted on the normal ~3 min cadence (no spin)", async () => {
    const calls = mockSkewedFetch(240_000);
    const { result } = renderHook(() => useFeedPlayback());
    act(() => result.current.prefetch(["a", "b"]));
    await settle();
    expect(calls).toHaveLength(2);

    // The tap uses the held url — skew did not make it look expired.
    await act(async () => {
      await result.current.play("a");
    });
    expect(calls).toHaveLength(2);

    // 60 s on: no re-mint yet (the old code re-minted both keys every second).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(2);
    // ~180 s in: one re-mint per wanted key.
    await vi.advanceTimersByTimeAsync(125_000);
    expect(calls).toHaveLength(4);
  });

  it("a url that arrives already inside the margin is kept for nothing and NOT retried: no loop", async () => {
    const calls = mockPlaybackFetch(() => ({ expiresInMs: 30_000 }));
    const { result } = renderHook(() => useFeedPlayback());
    act(() => result.current.prefetch(["a"]));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
  });
});

describe("useFeedPlayback pre-mint — refusals are silent", () => {
  it("a 402 pre-mint: no url, no pill; the tap makes its OWN request and owns the error (402 -> failed)", async () => {
    const calls = mockPlaybackFetch(() => ({ status: 402 }));
    const { result } = renderHook(() => useFeedPlayback());

    act(() => result.current.prefetch(["a"]));
    await settle();
    expect(calls).toHaveLength(1);
    expect(result.current.failed("a")).toBe(false);
    expect(result.current.urlFor("a")).toBeUndefined();

    // Not retried by another prefetch of the same page…
    act(() => result.current.prefetch(["a"]));
    await settle();
    expect(calls).toHaveLength(1);

    let outcome!: string;
    await act(async () => {
      outcome = await result.current.play("a");
    });
    expect(calls).toHaveLength(2);
    expect(outcome).toBe("failed");
    expect(result.current.failed("a")).toBe(true);
    expect(result.current.playingKey).toBeNull();
  });

  it("a network error on the pre-mint raises no pill either", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useFeedPlayback());
    act(() => result.current.prefetch(["a"]));
    await settle();
    expect(result.current.failed("a")).toBe(false);
  });
});

describe("useFeedPlayback pre-mint — carousel focus, reset, no autoplay", () => {
  it("focus(id, 2) while id is wanted mints /playback?videoIndex=2", async () => {
    const calls = mockPlaybackFetch();
    const { result } = renderHook(() => useFeedPlayback());
    act(() => result.current.prefetch(["a"]));
    await settle();
    act(() => result.current.focus("a", 2));
    await settle();
    expect(calls).toEqual(["/api/posts/a/playback", "/api/posts/a/playback?videoIndex=2"]);

    // and the tap on slide 2 starts from it, with no request.
    await act(async () => {
      await result.current.play("a", 2);
    });
    expect(calls).toHaveLength(2);
    expect(result.current.playingKey).toBe("a:2");
  });

  it("focus() on a post that is NOT wanted mints nothing", async () => {
    const calls = mockPlaybackFetch();
    const { result } = renderHook(() => useFeedPlayback());
    act(() => result.current.focus("zzz", 2));
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("reset() clears the held urls: a later play(id) makes a fresh request", async () => {
    const calls = mockPlaybackFetch();
    const { result } = renderHook(() => useFeedPlayback());
    act(() => result.current.prefetch(["a"]));
    await settle();
    act(() => result.current.reset());
    await act(async () => {
      await result.current.play("a");
    });
    expect(calls).toEqual(["/api/posts/a/playback", "/api/posts/a/playback"]);
  });

  it("guardrail: a pre-mint never sets playingKey (no autoplay) and renders no url", async () => {
    mockPlaybackFetch();
    const { result } = renderHook(() => useFeedPlayback());
    act(() => result.current.prefetch(["a", "b"]));
    await settle();
    expect(result.current.playingKey).toBeNull();
    expect(result.current.urlFor("a")).toBeUndefined();
    expect(result.current.urlFor("b")).toBeUndefined();
  });
});
