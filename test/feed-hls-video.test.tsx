// ENG-1059 — the five member feeds (Explore, Following, Saved, horse-profile,
// trainer-profile) had their own bare `<video controls autoPlay src>` and now
// render `HlsVideo` instead, inside the SAME `mediaBoxProps(..., { video: true
// })` box they always drew. This suite pins that swap once, parametrised over
// all five, rather than five near-identical copies — a sixth feed is one
// array entry away from the same coverage.
//
// Per-feed cases (a)-(d) below reuse the hls.js/jsdom rig test/media-player.test.tsx
// proved out for HlsVideo directly:
//   - `HTMLMediaElement.prototype.play` is unimplemented in jsdom — stubbed below.
//   - `canPlayType` is stubbed per test: `""` drives the hls.js path (Chrome/
//     Firefox/Edge), which is the only path these cases exercise — the native
//     Safari path is already pinned per-component by hls-video's own suite and
//     is out of scope for a "does the feed wire it up" test.
// Plus two file-level guards (e)/(f) that are not per-feed at all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act, within } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ExploreFeed } from "@/app/(member)/explore/explore-feed";
import { FollowingScreen } from "@/app/(member)/following/following-screen";
import { SavedFeed } from "@/app/(member)/saved/saved-feed";
import { HorsePosts } from "@/app/(member)/horses/[id]/horse-posts";
import { TrainerPosts } from "@/app/(member)/trainers/[id]/trainer-posts";

const VIEWER_ID = "8f3c1a2b-1234-4abc-9def-0123456789ab";
const PLAYBACK_URL = "https://stream.mux.com/pb-fixture.m3u8?token=fake.jwt.token";
const POSTER = "https://storage.test/sign/post-media/posters/p1.jpg";
const ACTIVE_SUB = { status: "active", trial_ends_at: null, current_period_end: "2099-01-01T00:00:00.000Z" };

// ---------------------------------------------------------------------------
// hls.js mock — LIFTED VERBATIM from test/media-player.test.tsx. `state.imported`
// counts accesses to the mocked module's `default` binding via a getter — the
// real component destructures `{ default: HlsCtor }` off the dynamic
// `import("hls.js")`, so the getter fires exactly once per attempted import and
// never otherwise. (That component behaviour was proven against the real
// HlsVideo in media-player.test.tsx's own header comment; not re-proven here.)
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

// ---------------------------------------------------------------------------
// One supabase mock for every feed — all five import `supabaseBrowser` from the
// SAME module path, so `vi.mock` can only be declared once per file. Each
// case's `tables()` below reconfigures `fromMock` for its own screen.
// ---------------------------------------------------------------------------
const { fromMock, storageFromMock } = vi.hoisted(() => ({
  fromMock: vi.fn(),
  storageFromMock: vi.fn((_bucket: string) => ({
    createSignedUrls: (paths: string[]) =>
      Promise.resolve({ data: paths.map((path) => ({ path, signedUrl: `https://sb.local/signed/${path}` })) }),
  })),
}));

vi.mock("@/lib/supabase/client", () => ({
  supabaseBrowser: () => ({
    from: fromMock,
    storage: { from: storageFromMock },
  }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

/** A chainable Supabase-style query builder: every filter returns itself, and
 * it resolves via `.then` (list reads) or `.maybeSingle` (the subscription
 * gate) — the superset of shapes the five feeds' own suites already use. */
function chainable(result: { data: unknown; error: unknown }) {
  const obj: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "not", "order", "limit", "lt"]) obj[m] = vi.fn(() => obj);
  obj.delete = vi.fn(() => obj);
  obj.maybeSingle = vi.fn(() => Promise.resolve(result));
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onFulfilled, onRejected);
  return obj;
}

/** SavedFeed's `bookmark` read is `.select().lt().order().limit()` (a list),
 * plus a SEPARATE `.delete().eq()` write — one object needs both shapes. */
function bookmarkBuilder(rows: unknown[]) {
  const obj: Record<string, unknown> = {};
  obj.select = vi.fn(() => obj);
  obj.lt = vi.fn(() => obj);
  obj.limit = vi.fn(() => obj);
  obj.order = vi.fn(() => obj);
  obj.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
  obj.delete = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));
  return obj;
}

/** One `post` row, shaped as a VIDEO with a poster key so `resolvePostDisplayUrls`
 * mints it via `GET .../playback?posterOnly=1` — every field `postIntrinsics`
 * reads is present so nothing silently becomes `undefined`. */
function videoRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "video",
    title: null,
    label: null,
    body: "Gallop replay.",
    media_url: null,
    poster_url: `posts/${id}-poster.jpg`,
    aspect_ratio: null,
    watermarked: false,
    like_count: 2,
    published_at: "2026-07-10T00:00:00.000Z",
    ...extra,
  };
}

/**
 * Routes `global.fetch` BY URL, because every one of these feeds also POSTs
 * `/api/posts/media` (a batch mint, harmless empty-array no-op here since the
 * fixture is a single VIDEO post, not a photo) and GETs the list poster on
 * mount. `listing` is the ONE route each feed case owns for its own post list
 * (`/api/feed`, `/api/feed/following`, `/api/horses/:id/feed`,
 * `/api/trainers/:id/feed` — or `undefined` for SavedFeed, whose list comes
 * from `bookmark`, not a fetch route at all). Anything unmatched THROWS,
 * so a missed route surfaces as a loud failure instead of a silent 404.
 */
function buildFetch(opts: {
  mintStatus: 200 | 402;
  listing: (url: string) => unknown | undefined;
}) {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);

    if (url.startsWith("/api/feed/seen")) {
      return { ok: true, status: 204, json: async () => ({}) };
    }

    // The feed's own Play-button mint: `apiFetch(\`/api/posts/\${id}/playback\`)`
    // — a bare GET, never `posterOnly`. This is the ONLY route this suite's (a)
    // asserts is the source of the string hls.js loads (guardrail 6).
    if (/^\/api\/posts\/[^/]+\/playback$/.test(url)) {
      if (opts.mintStatus === 402) {
        return { ok: false, status: 402, json: async () => ({ error: { code: "subscription_required" } }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { playbackUrl: PLAYBACK_URL, posterUrl: POSTER, expiresAt: "2026-09-10T00:10:00.000Z" },
        }),
      };
    }

    // The LIST poster mint (`resolvePostDisplayUrls`, ran on mount for every
    // video row) — deliberately a DIFFERENT url shape from the Play mint above,
    // and never the one hls.js is allowed to load.
    if (url.includes("/playback?posterOnly=1")) {
      const id = url.match(/\/posts\/([^/]+)\/playback/)?.[1] ?? "unknown";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { posterUrl: `https://sb.local/posters/${id}.jpg`, expiresAt: "2026-09-10T00:10:00.000Z" },
        }),
      };
    }

    if (url === "/api/posts/media" || url.startsWith("/api/posts/media?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { items: [], expiresAt: "2026-09-10T00:10:00.000Z" } }),
      };
    }

    const listed = opts.listing(url);
    if (listed !== undefined) {
      return { ok: true, status: 200, json: async () => listed };
    }

    throw new Error(`feed-hls-video.test: unmocked fetch — ${url}`);
  });
}

interface FeedCase {
  name: string;
  /** Reconfigures `fromMock` for this screen's own supabase reads. */
  tables: () => void;
  /** This screen's own post-list route, or `undefined` (not a fetch route at all). */
  listing: (url: string) => unknown | undefined;
  render: () => RenderResult;
}

const CASES: FeedCase[] = [
  {
    name: "ExploreFeed",
    tables: () => {
      fromMock.mockImplementation((table: string) => {
        if (table === "horse") {
          return chainable({
            data: [{ id: "h1", display_name: "Mahogany", photo_url: null, trainer: { id: "t1", name: "Chris Waller", stable_name: null, location: null, photo_url: null } }],
            error: null,
          });
        }
        return chainable({ data: [], error: null });
      });
    },
    listing: (url) =>
      url === "/api/feed" || url.startsWith("/api/feed?")
        ? { data: [videoRow("p1", { horse_id: "h1" })], meta: { nextCursor: null, hasMore: false } }
        : undefined,
    render: () => render(<ExploreFeed viewerId={VIEWER_ID} everSubscribed={false} />),
  },
  {
    name: "FollowingScreen",
    tables: () => {
      fromMock.mockImplementation((table: string) => {
        if (table === "subscription") return chainable({ data: ACTIVE_SUB, error: null });
        if (table === "horse") {
          return chainable({
            data: [{ id: "fh1", display_name: "Mahogany", trainer: { id: "t9", name: "G. Waterhouse", stable_name: null, location: null } }],
            error: null,
          });
        }
        return chainable({ data: [], error: null }); // follow rails, reaction, bookmark
      });
    },
    listing: (url) =>
      url.startsWith("/api/feed/following")
        ? { data: [videoRow("p1", { horse_id: "fh1" })], meta: { nextCursor: null, hasMore: false } }
        : undefined,
    render: () => render(<FollowingScreen viewerId={VIEWER_ID} everSubscribed={false} />),
  },
  {
    name: "SavedFeed",
    tables: () => {
      fromMock.mockImplementation((table: string) => {
        if (table === "subscription") return chainable({ data: ACTIVE_SUB, error: null });
        if (table === "bookmark") {
          return bookmarkBuilder([{ created_at: "2026-07-12T00:00:00.000Z", post: videoRow("p1", { horse_id: "h1" }) }]);
        }
        if (table === "horse") {
          return chainable({
            data: [{ id: "h1", display_name: "Mahogany", trainer: { name: "Chris Waller", stable_name: null, location: null } }],
            error: null,
          });
        }
        return chainable({ data: [], error: null }); // reaction
      });
    },
    // SavedFeed's own post list comes from the `bookmark` table above, never a
    // fetch route — every `listing` case here is legitimately unmatched.
    listing: () => undefined,
    render: () => render(<SavedFeed viewerId={VIEWER_ID} everSubscribed={false} />),
  },
  {
    name: "HorsePosts",
    tables: () => {
      fromMock.mockImplementation(() => chainable({ data: [], error: null })); // reaction, bookmark
    },
    listing: (url) =>
      url === "/api/horses/h1/feed" ? { data: [videoRow("p1")] } : undefined,
    render: () =>
      render(
        <HorsePosts horseId="h1" horseName="Mahogany" trainerName="Chris Waller" viewerId={VIEWER_ID} />,
      ),
  },
  {
    name: "TrainerPosts",
    tables: () => {
      fromMock.mockImplementation(() => chainable({ data: [], error: null })); // reaction, bookmark
    },
    listing: (url) =>
      url === "/api/trainers/t1/feed"
        ? {
            data: [
              videoRow("p1", {
                horse_id: "h1",
                horse: { display_name: "Mahogany", racing_name: "Mahogany", photo_url: null },
              }),
            ],
          }
        : undefined,
    render: () =>
      render(<TrainerPosts trainerId="t1" trainerName="Chris Waller" viewerId={VIEWER_ID} />),
  },
];

beforeEach(() => {
  state.imported = 0;
  state.instances = [];
  fromMock.mockReset();
  storageFromMock.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each(CASES)("$name — feed HlsVideo wiring (ENG-1059)", (testCase) => {
  /** Mounts the feed, presses Play, and waits for the mint round trip to settle
   * (either the `<video>` mounts, or the pill renders on a 402). */
  async function mountAndPlay(mintStatus: 200 | 402) {
    testCase.tables();
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("");
    global.fetch = buildFetch({ mintStatus, listing: testCase.listing }) as unknown as typeof fetch;

    const user = userEvent.setup();
    const utils = testCase.render();
    await user.click(await utils.findByRole("button", { name: "Play video" }));
    return utils;
  }

  it("(a) mint 200: hls.js loads exactly the minted playbackUrl and attaches the mounted video", async () => {
    const utils = await mountAndPlay(200);

    await waitFor(() => expect(utils.container.querySelector("video")).not.toBeNull());
    // Guardrail 6 — the mint's `playbackUrl` is the ONLY string ever loaded.
    expect(state.instances).toHaveLength(1);
    const instance = state.instances[0];
    expect(instance.loadSource).toHaveBeenCalledTimes(1);
    expect(instance.loadSource).toHaveBeenCalledWith(PLAYBACK_URL);

    const video = utils.container.querySelector("video")!;
    expect(instance.attachMedia).toHaveBeenCalledTimes(1);
    expect(instance.attachMedia).toHaveBeenCalledWith(video);
  });

  it("(b) a fatal hls.js ERROR unmounts the video and shows the feed's pill; a non-fatal one does neither", async () => {
    const utils = await mountAndPlay(200);
    await waitFor(() => expect(utils.container.querySelector("video")).not.toBeNull());

    const instance = state.instances[0];
    const errorHandler = instance.handlers.get("hlsError");
    expect(typeof errorHandler).toBe("function");

    // Non-fatal FIRST: hls.js recovers from these itself, so tearing the player
    // down here would kill a stream that was about to heal — the same rule
    // hls-video.tsx documents for its own ERROR handler.
    await act(async () => {
      errorHandler?.("hlsError", { fatal: false });
    });
    expect(utils.container.querySelector("video")).not.toBeNull();
    expect(within(utils.container).queryByRole("alert")).toBeNull();

    // A FATAL one degrades to the existing "Couldn't load the video." pill —
    // the same pill a failed mint already produces on this screen.
    await act(async () => {
      errorHandler?.("hlsError", { fatal: true });
    });
    await waitFor(() => expect(utils.container.querySelector("video")).toBeNull());
    expect(within(utils.container).getByRole("alert")).toHaveTextContent(/Couldn.t load the video\./);
  });

  it("(c) a 402 mint never mounts a video, shows the pill, and never pays for the hls.js chunk", async () => {
    const utils = await mountAndPlay(402);

    await waitFor(() =>
      expect(within(utils.container).getByRole("alert")).toHaveTextContent(/Couldn.t load the video\./),
    );
    expect(utils.container.querySelector("video")).toBeNull();
    // The gate must be paid before the chunk is — a 402 must not even import it.
    expect(state.imported).toBe(0);
    expect(state.instances).toHaveLength(0);
  });

  it("(d) unmounting the feed while the video is playing calls destroy() exactly once", async () => {
    const utils = await mountAndPlay(200);
    await waitFor(() => expect(utils.container.querySelector("video")).not.toBeNull());

    const instance = state.instances[0];
    expect(instance.destroy).not.toHaveBeenCalled();

    utils.unmount();

    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// (e)/(f) — file-level guards, not per-feed. Lifted from the recursive-readdir
// style in test/media-player.test.tsx's own "stream.mux.com literal" guard.
// ===========================================================================
const MEMBER_FEED_FILES = [
  "app/(member)/explore/explore-feed.tsx",
  "app/(member)/following/following-screen.tsx",
  "app/(member)/saved/saved-feed.tsx",
  "app/(member)/horses/[id]/horse-posts.tsx",
  "app/(member)/trainers/[id]/trainer-posts.tsx",
];

/**
 * Strip comments before any source-grep assertion.
 *
 * `.rx/gotchas.md` records this exact trap: a guard greps raw source, and the
 * code that satisfies it EXPLAINS itself in a comment that names the very token
 * the guard forbids — so the change reds its own guard. Both of these files now
 * carry a comment reading "Deliberately NO `autoPlay`", which is precisely the
 * prose a reader needs and precisely what a raw `.includes("autoPlay")` would
 * trip on. Strip first, then match. Same helper shape as
 * test/shares-segregation-guard.test.ts.
 */
function stripComments(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // NOT the naive `/\/\/.*$/gm` that test/shares-segregation-guard.test.ts and
      // test/media-player.test.tsx use: that one also blanks a line from the `//`
      // inside a `https://…` literal onwards, so a forbidden token sitting AFTER a
      // URL on the same line escapes the grep. Requiring the `//` not to be preceded
      // by `:` keeps real comments (which start a line here) while leaving URLs whole.
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
  );
}

describe("(e) GUARDRAIL — no member screen renders a bare <video> any more", () => {
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

  // Whitespace collapsed before matching — a guard that scans raw text is
  // defeated by a line wrap (see test/media-player.test.tsx's own version of
  // this comment, and test/owner-pii-guard.test.ts).
  function collapsed(path: string): string {
    return stripComments(readFileSync(path, "utf8")).replace(/\s+/g, " ");
  }

  const files = sourceFiles(join(process.cwd(), "app/(member)"));

  it("actually scanned a non-trivial set of files (the guard must not pass vacuously)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("contains the literal `<video` in NO file under app/(member)", () => {
    const offenders = files.filter((f) => collapsed(f).includes("<video"));
    expect(offenders).toEqual([]);
  });
});

describe("(f) GUARDRAIL — every one of the five feeds imports HlsVideo and carries no autoPlay", () => {
  it.each(MEMBER_FEED_FILES)("%s imports HlsVideo from @/components/hls-video and has no autoPlay attribute", (relPath) => {
    const src = stripComments(readFileSync(join(process.cwd(), relPath), "utf8"));
    // The POSITIVE anchor comes first and is asserted against the same stripped
    // string: a file that failed to load, or a strip() that ate everything,
    // would satisfy the `not.toContain` below vacuously. This line is what
    // proves the guard is looking at real code.
    expect(src).toContain('import { HlsVideo } from "@/components/hls-video";');
    // `autoPlay` would race HlsVideo's own explicit play() (see hls-video.tsx's
    // `startPlayback` doc comment) — the attribute must never come back.
    expect(src).not.toContain("autoPlay");
  });
});
