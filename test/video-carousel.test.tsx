// ENG-1599, MV-W1 — the video carousel, through the real `PostCard` + a REAL
// `useFeedPlayback()` (not a stub): the carousel's dots/chip/play buttons are
// driven by the SAME hook the five feeds share, so these tests exercise the
// actual mint → mount → auto-advance → one-at-a-time wiring, not a mock of it.
//
// The hls.js mock rig and the `HTMLMediaElement.prototype.play`/`canPlayType`
// stubs are LIFTED from test/feed-hls-video.test.tsx (itself lifted from
// test/media-player.test.tsx) — see those files' own header comments for why
// each piece exists. `state.instances[n].handlers.get("hlsManifestParsed")` is
// how a fake instance is made to call `video.play()` at all (media-player.test.tsx's
// "(j) a rejected play()" describe block), since our FakeHls never fires it on
// its own the way real hls.js would after parsing a manifest.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PostCard } from "@/components/post-card";
import { HlsVideo } from "@/components/hls-video";
import { useFeedPlayback } from "@/lib/feed/use-feed-playback";
import type { FeedPost } from "@/components/types";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";
const noop = () => {};

// ---------------------------------------------------------------------------
// hls.js mock — lifted verbatim from test/feed-hls-video.test.tsx.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  imported: 0,
  instances: [] as FakeHlsInstance[],
}));

interface FakeHlsInstance {
  handlers: Map<string, (...args: unknown[]) => void>;
  loadSource: ReturnType<typeof vi.fn>;
  attachMedia: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

class FakeHls implements FakeHlsInstance {
  static Events = { MANIFEST_PARSED: "hlsManifestParsed", ERROR: "hlsError" };
  static isSupported() {
    return true;
  }
  handlers = new Map<string, (...args: unknown[]) => void>();
  loadSource = vi.fn();
  attachMedia = vi.fn();
  destroy = vi.fn();
  on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    this.handlers.set(event, cb);
  });
  constructor() {
    state.instances.push(this);
  }
}

vi.mock("hls.js", () => ({
  get default() {
    state.imported += 1;
    return FakeHls;
  },
}));

function videoPost(overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    id: "v",
    horseId: "horse-1",
    horseName: "Winx",
    trainerName: "Chris Waller",
    postedAgo: "1d ago",
    label: null,
    body: "Trackwork today.",
    media: { type: "video", posterUrl: "https://sb.local/posters/v.jpg" },
    videoCount: 3,
    watermarked: false,
    raceBadge: null,
    count: 5,
    reacted: null,
    bookmarked: false,
    ...overrides,
  };
}

/** Every request a carousel can make, routed by shape rather than by post id
 * (both fixture posts share this fetch). `posterStatus`/`streamStatus` key by
 * `videoIndex` and override the default 200. */
function buildFetch(opts: { posterStatus?: Record<number, number>; streamStatus?: Record<number, number> } = {}) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    const m = url.match(/videoIndex=(\d+)/);
    const idx = m ? Number(m[1]) : 0;
    if (url.includes("posterOnly=1")) {
      const status = opts.posterStatus?.[idx] ?? 200;
      if (status !== 200) {
        return { ok: false, status, json: async () => ({ error: { code: status === 404 ? "not_found" : "x" } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { posterUrl: `https://sb.local/posters/v-${idx}.jpg`, expiresAt: "x" } }),
      };
    }
    const status = opts.streamStatus?.[idx] ?? 200;
    if (status !== 200) {
      return { ok: false, status, json: async () => ({ error: { code: "x" } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { playbackUrl: `https://stream.mux.com/v-${idx}.m3u8?token=fake`, expiresAt: "x" } }),
    };
  });
}

/** The real `useFeedPlayback()`, wired to a single video-carousel post's
 * `PostCard`, plus the SAME pill the feeds draw on `playback.failed()`. */
function CarouselHarness({ post }: { post: FeedPost }) {
  const playback = useFeedPlayback();
  return (
    <>
      <PostCard post={post} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} playback={playback} />
      {playback.failed(post.id) && <p role="alert">Couldn&rsquo;t load the video.</p>}
    </>
  );
}

/** Two cards sharing ONE hook instance — the single-video card's shape mirrors
 * explore-feed.tsx: an inline `<HlsVideo>` when playing, else the card with
 * `onPlay`. Proves the carousel and a plain single-video card cannot both play
 * at once. */
function TwoCardHarness({ carousel, single }: { carousel: FeedPost; single: FeedPost }) {
  const playback = useFeedPlayback();
  const singleUrl = playback.inlineUrl(single);
  return (
    <>
      {singleUrl ? (
        <HlsVideo
          src={singleUrl}
          poster={single.media.posterUrl ?? undefined}
          controls
          playsInline
          onFatalError={() => playback.onFatal(single.id)}
        />
      ) : (
        <PostCard
          post={single}
          viewerId={VIEWER_ID}
          onReact={noop}
          onBookmark={noop}
          onPlay={() => void playback.play(single.id)}
        />
      )}
      <PostCard post={carousel} viewerId={VIEWER_ID} onReact={noop} onBookmark={noop} playback={playback} />
    </>
  );
}

let scrollToSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  state.imported = 0;
  state.instances = [];
  scrollToSpy = vi.fn();
  Object.defineProperty(Element.prototype, "scrollTo", {
    value: scrollToSpy,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    value: 360,
    writable: true,
    configurable: true,
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("VideoCarousel — dots, chip and slide buttons (1)", () => {
  it("draws one dot and one 'Play video N of 3' button per slide, the counted chip, and no single card play button", async () => {
    global.fetch = buildFetch() as unknown as typeof fetch;
    render(<CarouselHarness post={videoPost()} />);
    await screen.findByTestId("video-dots");

    const dots = within(screen.getByTestId("video-dots")).getAllByRole("button");
    expect(dots).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Go to video 1 of 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to video 2 of 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to video 3 of 3" })).toBeInTheDocument();

    expect(screen.getByTestId("media-video-chip")).toHaveAttribute("aria-label", "Video 1 of 3");
    expect(screen.getByTestId("media-video-count")).toHaveTextContent("1/3");

    // The card's OWN single-video play button is suppressed for a carousel.
    expect(screen.queryByRole("button", { name: "Play video" })).toBeNull();

    expect(screen.getByRole("button", { name: "Play video 1 of 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play video 2 of 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play video 3 of 3" })).toBeInTheDocument();
  });
});

describe("VideoCarousel — lazy poster minting (2)", () => {
  it("mints only the poster one ahead of active, once per index", async () => {
    const fetchMock = buildFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CarouselHarness post={videoPost()} />);
    await screen.findByTestId("video-dots");

    const posterCalls = () =>
      fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("posterOnly=1"));

    await waitFor(() => {
      expect(posterCalls()).toEqual(["/api/posts/v/playback?posterOnly=1&videoIndex=1"]);
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Go to video 2 of 3" }));

    await waitFor(() => {
      expect(posterCalls().sort()).toEqual([
        "/api/posts/v/playback?posterOnly=1&videoIndex=1",
        "/api/posts/v/playback?posterOnly=1&videoIndex=2",
      ]);
    });

    // Never more than once per index: navigating back and forth must not
    // re-mint index 1.
    await user.click(screen.getByRole("button", { name: "Go to video 1 of 3" }));
    await user.click(screen.getByRole("button", { name: "Go to video 2 of 3" }));
    expect(posterCalls().sort()).toEqual([
      "/api/posts/v/playback?posterOnly=1&videoIndex=1",
      "/api/posts/v/playback?posterOnly=1&videoIndex=2",
    ]);
  });
});

describe("VideoCarousel — playing a slide mints its stream by index (3)", () => {
  it("mints ?videoIndex=1 and loadSource()s the minted url; slide 0 mints the bare route", async () => {
    const fetchMock = buildFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CarouselHarness post={videoPost()} />);
    await screen.findByTestId("video-dots");

    const streamCalls = () =>
      fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => !String(u).includes("posterOnly"));

    await user.click(screen.getByRole("button", { name: "Go to video 2 of 3" }));
    await user.click(screen.getByRole("button", { name: "Play video 2 of 3" }));

    await waitFor(() => expect(streamCalls()).toContain("/api/posts/v/playback?videoIndex=1"));
    await waitFor(() => expect(document.querySelector('[data-video-index="1"] video')).not.toBeNull());
    const mounted = state.instances[state.instances.length - 1];
    expect(mounted.loadSource).toHaveBeenCalledWith("https://stream.mux.com/v-1.m3u8?token=fake");

    // Slide 0's play button mints the BARE route (index 0 is omitted).
    await user.click(screen.getByRole("button", { name: "Go to video 1 of 3" }));
    await user.click(screen.getByRole("button", { name: "Play video 1 of 3" }));
    await waitFor(() => expect(streamCalls()).toContain("/api/posts/v/playback"));
  });
});

describe("VideoCarousel — auto-advance on ended (4)", () => {
  it("advances the chip/dot, mints and mounts the next slide, and stops at the last one", async () => {
    const fetchMock = buildFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CarouselHarness post={videoPost()} />);
    await screen.findByTestId("video-dots");

    await user.click(screen.getByRole("button", { name: "Play video 1 of 3" }));
    await waitFor(() => expect(document.querySelector('[data-video-index="0"] video')).not.toBeNull());

    const video0 = document.querySelector('[data-video-index="0"] video') as HTMLVideoElement;
    fireEvent.ended(video0);

    // The chip/dot flip synchronously with the ended handler's setActive.
    await waitFor(() => expect(screen.getByTestId("media-video-count")).toHaveTextContent("2/3"));
    const dots = within(screen.getByTestId("video-dots")).getAllByRole("button");
    expect(dots[1]).toHaveAttribute("aria-current", "true");

    const streamCalls = () =>
      fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => !String(u).includes("posterOnly"));
    await waitFor(() => expect(streamCalls()).toContain("/api/posts/v/playback?videoIndex=1"));
    await waitFor(() => expect(document.querySelector('[data-video-index="1"] video')).not.toBeNull());

    // The LAST slide: ended makes no further mint.
    await user.click(screen.getByRole("button", { name: "Go to video 3 of 3" }));
    await user.click(screen.getByRole("button", { name: "Play video 3 of 3" }));
    await waitFor(() => expect(document.querySelector('[data-video-index="2"] video')).not.toBeNull());
    const callsBefore = fetchMock.mock.calls.length;
    const video2 = document.querySelector('[data-video-index="2"] video') as HTMLVideoElement;
    fireEvent.ended(video2);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });
});

describe("VideoCarousel — a play() rejection on auto-advance (5)", () => {
  it("draws the play button over the mounted video, no pill, and clicking it retries play()", async () => {
    const fetchMock = buildFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CarouselHarness post={videoPost()} />);
    await screen.findByTestId("video-dots");

    await user.click(screen.getByRole("button", { name: "Play video 1 of 3" }));
    await waitFor(() => expect(state.instances.length).toBe(1));
    // Slide 0's own manifest parse lands normally (play() resolves).
    await act(async () => {
      state.instances[0].handlers.get("hlsManifestParsed")?.();
      await Promise.resolve();
    });

    // The auto-advance's play() is the one that gets refused.
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      Object.assign(new Error("blocked"), { name: "NotAllowedError" }),
    );

    const video0 = document.querySelector('[data-video-index="0"] video') as HTMLVideoElement;
    fireEvent.ended(video0);

    await waitFor(() => expect(state.instances.length).toBe(2));
    await waitFor(() => expect(document.querySelector('[data-video-index="1"] video')).not.toBeNull());
    await act(async () => {
      state.instances[1].handlers.get("hlsManifestParsed")?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Play video 2 of 3" })).toBeInTheDocument());
    expect(screen.queryByRole("alert")).toBeNull();
    // The video stays mounted — a blocked autostart is not a failure.
    expect(document.querySelector('[data-video-index="1"] video')).not.toBeNull();

    const playSpy = vi.mocked(HTMLMediaElement.prototype.play);
    const before = playSpy.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Play video 2 of 3" }));
    expect(playSpy.mock.calls.length).toBeGreaterThan(before);
  });
});

describe("VideoCarousel — a 404 poster mint hides that slide (6)", () => {
  it("recomputes the dots and the chip around the hidden slide", async () => {
    global.fetch = buildFetch({ posterStatus: { 1: 404 } }) as unknown as typeof fetch;
    render(<CarouselHarness post={videoPost()} />);
    await screen.findByTestId("video-dots");

    await waitFor(() => {
      const dots = within(screen.getByTestId("video-dots")).getAllByRole("button");
      expect(dots).toHaveLength(2);
    });
    expect(screen.getByRole("button", { name: "Go to video 1 of 2" })).toBeInTheDocument();
    expect(screen.getByTestId("media-video-chip")).toHaveAttribute("aria-label", "Video 1 of 2");
    expect(screen.getByTestId("media-video-count")).toHaveTextContent("1/2");
  });
});

describe("VideoCarousel — a 402 stream mint (7)", () => {
  it("raises the pill, mounts no video, and never imports hls.js", async () => {
    global.fetch = buildFetch({ streamStatus: { 0: 402 } }) as unknown as typeof fetch;
    const user = userEvent.setup();
    render(<CarouselHarness post={videoPost()} />);
    await screen.findByTestId("video-dots");

    await user.click(screen.getByRole("button", { name: "Play video 1 of 3" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/Couldn.t load the video\./));
    expect(document.querySelector("video")).toBeNull();
    expect(state.imported).toBe(0);
  });
});

describe("VideoCarousel — one player feed-wide (8)", () => {
  it("starting a carousel slide stops a plain single-video card's inline player", async () => {
    global.fetch = buildFetch() as unknown as typeof fetch;
    const user = userEvent.setup();
    const carousel = videoPost({ id: "v" });
    const single = videoPost({
      id: "s",
      videoCount: 1,
      media: { type: "video", posterUrl: "https://sb.local/posters/s.jpg" },
    });
    render(<TwoCardHarness carousel={carousel} single={single} />);

    await user.click(screen.getByRole("button", { name: "Play video" }));
    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));

    await screen.findByTestId("video-dots");
    await user.click(screen.getByRole("button", { name: "Play video 1 of 3" }));

    await waitFor(() => expect(document.querySelectorAll("video")).toHaveLength(1));
  });
});
