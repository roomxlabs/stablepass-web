// ENG-1056 — MediaPlayer's `<video>` is now `HlsVideo`, which routes a minted
// Mux playback URL through hls.js (Chrome/Firefox/Edge) or plays it natively
// (Safari/iOS). This suite pins the transport switch, the fatal-error path
// that degrades back to the poster + pill, and the guardrails: the mint's
// `playbackUrl` is the ONLY string ever loaded (guardrail 6), and the
// `stream.mux.com` literal never appears in shipped source (guardrail 1 — the
// signed URL must not be hardcoded/logged anywhere reachable at runtime).
//
// jsdom notes (see hls-video.tsx / media-player.tsx for the behaviour these
// pin):
//   - `HTMLMediaElement.prototype.play` is unimplemented in jsdom — stubbed
//     in `beforeEach` below.
//   - `canPlayType` is stubbed per test: `""` (Chrome/Firefox/Edge — the
//     hls.js path) or `"maybe"` (Safari — the native path).
//   - jsdom's `readyState` is always 0 for a freshly-mounted `<video>`, so the
//     native path always takes the `loadedmetadata` listener branch, never
//     the immediate-play branch.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { MediaPlayer } from "@/components/media-player";

const PLAYBACK_URL = "https://stream.mux.com/pb-fixture.m3u8?token=fake.jwt.token";
const POSTER = "https://storage.test/sign/post-media/posters/p1.jpg";

// ---------------------------------------------------------------------------
// hls.js mock. `state.imported` counts accesses to the mocked module's
// `default` binding via a getter — the real component destructures
// `{ default: HlsCtor }` off the dynamic `import("hls.js")`, so the getter
// fires exactly once per attempted import and never otherwise.
//
// PROVEN, not assumed: before writing this suite, the getter was wired up
// against the REAL `HlsVideo` component (not a stand-in) in a throwaway spec
// and run under `npx vitest run`. Rendering `HlsVideo` with
// `canPlayType → ""` drove `state.imported` to exactly 1 and created exactly
// one `FakeHls` instance; rendering it with `canPlayType → "maybe"` left
// `state.imported` at 0. The throwaway file was deleted after confirming
// this. The counter below is therefore a genuine assertion, not a
// best-effort one.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  imported: 0,
  instances: [] as FakeHlsInstance[],
  isSupported: true,
}));

interface FakeHlsInstance {
  /**
   * The config object the component passed to `new Hls(...)`. Captured
   * verbatim (ENG-1063) so `debug: false` — the one thing standing between
   * hls.js's logger and the Mux token in the manifest URL (guardrail 1) — is
   * an asserted argument rather than a line someone can delete silently.
   */
  config: unknown;
  handlers: Map<string, (...args: unknown[]) => void>;
  loadSource: ReturnType<typeof vi.fn>;
  attachMedia: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

class FakeHls implements FakeHlsInstance {
  static Events = { MANIFEST_PARSED: "hlsManifestParsed", ERROR: "hlsError" };
  static isSupported() {
    return state.isSupported;
  }
  handlers = new Map<string, (...args: unknown[]) => void>();
  loadSource = vi.fn();
  attachMedia = vi.fn();
  destroy = vi.fn();
  on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    this.handlers.set(event, cb);
  });
  config: unknown;
  constructor(config?: unknown) {
    this.config = config;
    state.instances.push(this);
  }
}

vi.mock("hls.js", () => ({
  get default() {
    state.imported += 1;
    return FakeHls;
  },
}));

function mintOk() {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: { playbackUrl: PLAYBACK_URL, posterUrl: POSTER, expiresAt: "2026-09-10T00:10:00.000Z" },
    }),
  })) as unknown as typeof fetch;
}

function mintGated() {
  global.fetch = vi.fn(async () => ({
    ok: false,
    status: 402,
    json: async () => ({ error: { code: "subscription_required" } }),
  })) as unknown as typeof fetch;
}

/**
 * Presses Play and waits for the `<video>` to mount.
 *
 * `posterUrl` here is the MediaPlayer PROP (the post's already-known
 * thumbnail), not the mint response's `data.posterUrl` — `media-player.tsx`
 * destructures only `data.playbackUrl` from the mint body and renders
 * `poster={posterUrl ?? undefined}` off its own prop, so the mint's
 * `posterUrl` field is inert as far as this component is concerned. Default
 * is an unrelated fixture value so tests that don't care about the poster
 * attribute don't accidentally couple to it.
 */
async function mountAndPlay(canPlayType: CanPlayTypeResult, posterUrl = "https://cdn/poster.jpg") {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(canPlayType);
  mintOk();
  const user = userEvent.setup();
  const utils = render(<MediaPlayer postId="p1" posterUrl={posterUrl} duration="1:12" />);
  await user.click(utils.getByRole("button", { name: "Play video" }));
  await waitFor(() => expect(utils.container.querySelector("video")).not.toBeNull());
  return utils;
}

beforeEach(() => {
  state.imported = 0;
  state.instances = [];
  state.isSupported = true;
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  // Like `play`, jsdom leaves `load` unimplemented — it reports a jsdomError
  // rather than throwing, so an unstubbed call would only pollute the output.
  // HlsVideo's native-path teardown calls it (ENG-1063), and two tests below
  // assert on this spy, so stub it here for every test rather than per-case.
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// (a) ---------------------------------------------------------------------
describe("(a) hls.js path — Chrome/Firefox/Edge (canPlayType === '')", () => {
  it("creates exactly one Hls instance, loads the minted url, attaches the rendered video, and MANIFEST_PARSED starts playback", async () => {
    const { container } = await mountAndPlay("");

    expect(state.instances).toHaveLength(1);
    const instance = state.instances[0];

    expect(instance.loadSource).toHaveBeenCalledTimes(1);
    expect(instance.loadSource).toHaveBeenCalledWith(PLAYBACK_URL);

    const video = container.querySelector("video")!;
    expect(instance.attachMedia).toHaveBeenCalledTimes(1);
    expect(instance.attachMedia).toHaveBeenCalledWith(video);

    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();
    const manifestParsed = instance.handlers.get("hlsManifestParsed");
    expect(typeof manifestParsed).toBe("function");

    await act(async () => {
      manifestParsed?.();
    });
    expect(playSpy).toHaveBeenCalledTimes(1);
  });
});

// (b) ---------------------------------------------------------------------
describe("(b) native path — Safari/iOS (canPlayType === 'maybe')", () => {
  it("sets video.src directly, never imports hls.js, and loadedmetadata starts playback", async () => {
    const { container } = await mountAndPlay("maybe");

    const video = container.querySelector("video")!;
    expect(video.src).toBe(PLAYBACK_URL);
    expect(state.imported).toBe(0);
    expect(state.instances).toHaveLength(0);

    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();
    await act(async () => {
      fireEvent.loadedMetadata(video);
    });
    expect(playSpy).toHaveBeenCalledTimes(1);
  });
});

// (c) ---------------------------------------------------------------------
describe("(c) fatal vs non-fatal hls.js ERROR", () => {
  it("a fatal ERROR tears the video down to the poster + 'Couldn't load video' pill", async () => {
    const { container, getByRole } = await mountAndPlay("");
    const instance = state.instances[0];
    const errorHandler = instance.handlers.get("hlsError");
    expect(typeof errorHandler).toBe("function");

    await act(async () => {
      errorHandler?.("hlsError", { fatal: true });
    });

    await waitFor(() => expect(container.querySelector("video")).toBeNull());
    expect(getByRole("alert")).toHaveTextContent("Couldn’t load video");
  });

  it("a NON-fatal ERROR does not tear the video down", async () => {
    const { container, queryByRole } = await mountAndPlay("");
    const instance = state.instances[0];
    const errorHandler = instance.handlers.get("hlsError");
    // Without this, the case would pass just as happily if the ERROR handler
    // had never been registered at all — an absence proving an absence.
    expect(typeof errorHandler).toBe("function");

    await act(async () => {
      errorHandler?.("hlsError", { fatal: false });
    });

    expect(container.querySelector("video")).not.toBeNull();
    expect(queryByRole("alert")).toBeNull();
  });
});

// (d) ---------------------------------------------------------------------
describe("(d) element `error` event", () => {
  it("a native <video> error event produces the same fatal outcome as a fatal hls.js error", async () => {
    const { container, getByRole } = await mountAndPlay("maybe");
    const video = container.querySelector("video")!;

    await act(async () => {
      fireEvent.error(video);
    });

    await waitFor(() => expect(container.querySelector("video")).toBeNull());
    expect(getByRole("alert")).toHaveTextContent("Couldn’t load video");
  });
});

describe("(d2) element `error` on the hls.js path is NOT the component's to classify", () => {
  it("leaves the video mounted — hls.js owns error classification once MSE is attached", async () => {
    const { container, queryByRole } = await mountAndPlay("");
    const video = container.querySelector("video")!;

    await act(async () => {
      fireEvent.error(video);
    });

    // hls.js recovers from plenty of element-level errors on its own (the same
    // reason a non-fatal `Hls.Events.ERROR` is ignored). Tearing down here would
    // kill a stream that was about to heal. The fatal path stays with
    // `Hls.Events.ERROR` + `data.fatal`, pinned by (c).
    expect(container.querySelector("video")).not.toBeNull();
    expect(queryByRole("alert")).toBeNull();
  });
});

// (e) ---------------------------------------------------------------------
describe("(e) unmount while the hls.js path is live", () => {
  it("calls destroy() exactly once", async () => {
    const { unmount } = await mountAndPlay("");
    const instance = state.instances[0];
    expect(instance.destroy).not.toHaveBeenCalled();

    unmount();

    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });

  // ENG-1063 (LOW-1) — the MSE path's teardown must stay exactly as it was.
  // `destroy()` owns the MediaSource (and the blob: URL hls.js put on the
  // element), so the new native-path release below must NOT also fire here:
  // clearing `src` out from under `destroy()` would be reaching into hls.js's
  // own teardown.
  it("does NOT release the element itself — destroy() owns the MSE path", async () => {
    const { unmount } = await mountAndPlay("");
    const loadSpy = vi.mocked(HTMLMediaElement.prototype.load);
    loadSpy.mockClear();

    unmount();

    expect(loadSpy).not.toHaveBeenCalled();
  });
});

// (e2) --------------------------------------------------------------------
describe("(e2) unmount on the NATIVE path releases the media resource (ENG-1063)", () => {
  // The leak this closes: `hls.destroy()` aborts in-flight segment requests,
  // but only on the MSE path. On Safari/iOS the element owns the load, so an
  // unmounted-but-still-buffering <video> kept its fetch alive — one live
  // download per card ever played, while scrolling a feed.
  it("drops the src attribute and re-runs the load algorithm", async () => {
    const { container, unmount } = await mountAndPlay("maybe");
    const video = container.querySelector("video")!;
    // Positive anchor: the native path really did load the minted URL, so the
    // release asserted below is releasing something rather than passing on an
    // element that was never loaded.
    expect(video.getAttribute("src")).toBe(PLAYBACK_URL);
    const loadSpy = vi.mocked(HTMLMediaElement.prototype.load);
    loadSpy.mockClear();

    unmount();

    expect(video.hasAttribute("src")).toBe(false);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });

  // The `isSupported() === false` fallback reaches the OTHER cleanup (the one
  // that also calls `hls?.destroy()`), having loaded natively. It must release
  // too — the guard is "did the element load it", not "which return ran".
  it("also releases when hls.js imported but was unsupported", async () => {
    state.isSupported = false;
    const { container, unmount } = await mountAndPlay("");
    const video = container.querySelector("video")!;
    expect(state.imported).toBe(1);
    expect(state.instances).toHaveLength(0);
    expect(video.getAttribute("src")).toBe(PLAYBACK_URL);
    const loadSpy = vi.mocked(HTMLMediaElement.prototype.load);
    loadSpy.mockClear();

    unmount();

    expect(video.hasAttribute("src")).toBe(false);
    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
});

// (f) ---------------------------------------------------------------------
describe("(f) GUARDRAIL — a gated mint never reaches the player", () => {
  it("a 402 mint renders no <video> and never imports hls.js", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    mintGated();
    const user = userEvent.setup();
    const { container, getByRole } = render(
      <MediaPlayer postId="p1" posterUrl="https://cdn/poster.jpg" duration="1:12" />,
    );

    await user.click(getByRole("button", { name: "Play video" }));

    await waitFor(() => expect(getByRole("alert")).toHaveTextContent("Couldn’t load video"));
    expect(container.querySelector("video")).toBeNull();
    expect(state.imported).toBe(0);
    expect(state.instances).toHaveLength(0);
  });
});

// (g) ---------------------------------------------------------------------
describe("(g) GUARDRAIL — the minted playbackUrl is the ONLY url ever loaded", () => {
  it("hls path: loadSource is called with exactly [PLAYBACK_URL], and the element's own src is never set", async () => {
    const { container } = await mountAndPlay("");
    const instance = state.instances[0];

    expect(instance.loadSource.mock.calls.flat()).toEqual([PLAYBACK_URL]);

    const video = container.querySelector("video")!;
    // hls.js attaches via MediaSource, not a `src` attribute — HlsVideo must
    // never ALSO set `video.src` on this path.
    expect(video.hasAttribute("src")).toBe(false);
  });

  it("native path: video.src is exactly PLAYBACK_URL and nothing else", async () => {
    const { container } = await mountAndPlay("maybe");
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(PLAYBACK_URL);
  });
});

// (h) ---------------------------------------------------------------------
describe("(h) GUARDRAIL — the stream.mux.com literal never appears in source", () => {
  const ROOTS = ["components", "app", "lib"];
  const SKIP_DIRS = new Set(["node_modules", ".next", ".claude"]);

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...sourceFiles(full));
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  // Whitespace is collapsed before matching: a guard that scans raw text is
  // defeated by a line wrap (an established repo gotcha — see
  // test/owner-pii-guard.test.ts).
  function collapsed(path: string): string {
    return readFileSync(path, "utf8").replace(/\s+/g, " ");
  }

  const files = ROOTS.flatMap((r) => sourceFiles(join(process.cwd(), r)));

  it("actually scanned a non-trivial set of files (the guard must not pass vacuously)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("contains the literal in NO scanned file", () => {
    const offenders = files.filter((f) => collapsed(f).includes("stream.mux.com"));
    expect(offenders).toEqual([]);
  });
});

// Decision 3 — poster/controls/playsInline, so iOS never takes over the
// screen with its own fullscreen player. The poster attribute is proven
// against MediaPlayer's own `posterUrl` PROP (see `mountAndPlay`'s doc
// comment) — the mint response's `posterUrl` field is not consumed by
// media-player.tsx today.
describe("rendered <video> attributes (ticket decision 3)", () => {
  it("carries the poster prop, controls, and playsinline", async () => {
    const { container } = await mountAndPlay("", POSTER);
    const video = container.querySelector("video")!;
    expect(video.getAttribute("poster")).toBe(POSTER);
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.hasAttribute("playsinline")).toBe(true);
  });
});

// (i) -----------------------------------------------------------------------
// The MSE-unavailable branch: an old browser or a locked-down webview where
// `Hls.isSupported()` is false. Shipped source, previously untested.
describe("(i) Hls.isSupported() === false — native attempt as the last resort", () => {
  it("imports hls.js, builds NO instance, and falls back to video.src", async () => {
    state.isSupported = false;
    const { container } = await mountAndPlay("");

    // It did try hls.js — this is the fallback INSIDE the hls path, not the
    // Safari branch, which is what distinguishes it from case (b).
    expect(state.imported).toBe(1);
    expect(state.instances).toHaveLength(0);

    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(PLAYBACK_URL);

    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    playSpy.mockClear();
    await act(async () => {
      fireEvent.loadedMetadata(video);
    });
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("and a failing element then still produces the honest pill", async () => {
    state.isSupported = false;
    const { container, getByRole } = await mountAndPlay("");
    const video = container.querySelector("video")!;

    await act(async () => {
      fireEvent.error(video);
    });

    await waitFor(() => expect(container.querySelector("video")).toBeNull());
    expect(getByRole("alert")).toHaveTextContent("Couldn’t load video");
  });
});

// (j) -----------------------------------------------------------------------
// A rejected `play()` promise. NOT every rejection is a broken stream, and
// getting this wrong regresses the one platform that already worked: Safari
// answers `NotAllowedError` when it declines to autostart, and the honest
// state there is a loaded, paused element with its controls — not an error.
describe("(j) a rejected play() is only fatal when it is really a transport failure", () => {
  /** Reject `play()` with a DOMException-shaped error of the given name. */
  function playRejects(name: string) {
    const err = new Error(`${name}: play() refused`);
    err.name = name;
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(err);
  }

  /** Mount on `path`, then trigger the point at which HlsVideo calls play(). */
  async function playAndSettle(canPlayType: CanPlayTypeResult, utils: ReturnType<typeof render>) {
    const video = utils.container.querySelector("video")!;
    await act(async () => {
      if (canPlayType === "") {
        state.instances[0].handlers.get("hlsManifestParsed")?.();
      } else {
        fireEvent.loadedMetadata(video);
      }
      // Let the rejected promise's catch run before we assert.
      await Promise.resolve();
    });
  }

  for (const benign of ["NotAllowedError", "AbortError"] as const) {
    it(`${benign} keeps the video mounted on the hls.js path`, async () => {
      const utils = await mountAndPlay("");
      playRejects(benign);
      await playAndSettle("", utils);

      expect(utils.container.querySelector("video")).not.toBeNull();
      expect(utils.queryByRole("alert")).toBeNull();
    });

    it(`${benign} keeps the video mounted on the native path`, async () => {
      const utils = await mountAndPlay("maybe");
      playRejects(benign);
      await playAndSettle("maybe", utils);

      expect(utils.container.querySelector("video")).not.toBeNull();
      expect(utils.queryByRole("alert")).toBeNull();
    });
  }

  it("a genuine decode failure (NotSupportedError) DOES produce the pill", async () => {
    const utils = await mountAndPlay("");
    playRejects("NotSupportedError");
    await playAndSettle("", utils);

    await waitFor(() => expect(utils.container.querySelector("video")).toBeNull());
    expect(utils.getByRole("alert")).toHaveTextContent("Couldn’t load video");
  });
});

// (k) ---------------------------------------------------------------------
// ENG-1063 (MEDIUM-2). Guardrail 1 says the signed URL must never reach the
// browser console, and `hls-video.tsx` satisfies it with one word: `debug:
// false` in the hls.js constructor config. hls.js's debug mode logs the
// manifest URL, and that URL carries the Mux token.
//
// Until now NOTHING in test/ looked at either half — not the constructor
// argument, not the console. A one-character edit (`false` → `true`) re-opened
// the guardrail with a fully green suite. These two cases close that: the
// first pins the intent, the second pins the OBSERVABLE consequence, so the
// guard survives hls.js changing how it spells the option.
describe("(k) GUARDRAIL 1 — `debug: false`, and the minted URL never reaches the console", () => {
  const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;

  /** Every console sink, silenced and recording. `vi.restoreAllMocks()` in `afterEach` undoes it. */
  function spyOnConsole() {
    return CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  }

  /**
   * Flatten what was logged into strings.
   *
   * NOT a bare `String(arg)`: an object stringifies to "[object Object]",
   * which would hide a `{ url }` payload and make every assertion below pass
   * vacuously — exactly the failure mode this file's other guards warn about.
   */
  function loggedText(spies: ReturnType<typeof spyOnConsole>): string[] {
    return spies
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return `${arg.name} ${arg.message} ${arg.stack ?? ""}`;
        try {
          return JSON.stringify(arg) ?? String(arg);
        } catch {
          return String(arg);
        }
      });
  }

  it("passes `debug: false` to the hls.js constructor", async () => {
    await mountAndPlay("");

    expect(state.instances).toHaveLength(1);
    const config = state.instances[0].config as Record<string, unknown> | undefined;
    // The config must EXIST — `new Hls()` with no argument would leave the
    // property assertion below reading `undefined` and is not what this
    // component may do.
    expect(config).toBeDefined();
    // Pinned to the literal `false`, not merely "falsy". Per the ticket's read
    // of hls.js 1.7.2 (node_modules/hls.js/dist/hls.js:2110-2138) only `true`
    // or an object enables the logger — but writing the intent down exactly is
    // the point: a reviewer seeing this line red knows the guardrail moved.
    expect(config!.debug).toBe(false);
    expect(config!.debug).not.toBe(true);
    expect(typeof config!.debug).not.toBe("object");
  });

  it("hls.js path: logs nothing containing the minted URL — not even when a fatal ERROR carries it", async () => {
    const spies = spyOnConsole();
    const { container, unmount } = await mountAndPlay("");
    const instance = state.instances[0];

    await act(async () => {
      instance.handlers.get("hlsManifestParsed")?.();
    });

    // The real hls.js ERROR payload carries `url` and `networkDetails`, both
    // of which hold the token-bearing manifest URL. This is the single most
    // likely place a future edit reaches for "just log the error" — so hand
    // the handler the loaded gun and assert it never fires.
    await act(async () => {
      instance.handlers.get("hlsError")?.("hlsError", {
        fatal: true,
        type: "networkError",
        details: "manifestLoadError",
        url: PLAYBACK_URL,
        networkDetails: { responseURL: PLAYBACK_URL },
      });
    });
    await waitFor(() => expect(container.querySelector("video")).toBeNull());

    unmount();

    const text = loggedText(spies);
    for (const line of text) {
      expect(line).not.toContain(PLAYBACK_URL);
      // The token alone is the secret; catch it even if the URL were split,
      // re-encoded or logged as a bare query string.
      expect(line).not.toContain("fake.jwt.token");
      expect(line).not.toContain("pb-fixture");
    }
  });

  it("native path: logs nothing containing the minted URL through load, failure and unmount", async () => {
    const spies = spyOnConsole();
    const { container, unmount } = await mountAndPlay("maybe");
    const video = container.querySelector("video")!;
    // Positive anchor — the URL really was in play on this render, so the
    // absence asserted below is meaningful.
    expect(video.src).toBe(PLAYBACK_URL);

    await act(async () => {
      fireEvent.loadedMetadata(video);
    });
    await act(async () => {
      fireEvent.error(video);
    });
    await waitFor(() => expect(container.querySelector("video")).toBeNull());

    unmount();

    for (const line of loggedText(spies)) {
      expect(line).not.toContain(PLAYBACK_URL);
      expect(line).not.toContain("fake.jwt.token");
      expect(line).not.toContain("pb-fixture");
    }
  });
});
