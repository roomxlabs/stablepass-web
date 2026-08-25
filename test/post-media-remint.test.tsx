import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { PostMediaImage } from "@/components/post-media-image";
import { PostCard } from "@/components/post-card";
import { MediaPlayer } from "@/components/media-player";
import type { FeedPost } from "@/components/types";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("PostMediaImage — ENG-813 onError re-mint", () => {
  it("re-mints once on an image error and swaps in the fresh url", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [{ postId: "p1", mediaUrl: "https://cdn/fresh.jpg" }],
          expiresAt: "x",
        },
      }),
    })) as unknown as typeof fetch;

    const { container } = render(<PostMediaImage postId="p1" src="https://cdn/expired.jpg" />);
    const img = container.querySelector("img")!;
    expect(img).toBeInTheDocument();

    fireEvent.error(img);

    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/fresh.jpg"));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/posts/media");
    expect(JSON.parse(String((init as RequestInit).body)).postIds).toEqual(["p1"]);
  });

  it("asks only for the affected postId — a re-mint never refetches the page", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [{ postId: "p1", mediaUrl: "https://cdn/fresh.jpg" }],
          expiresAt: "x",
        },
      }),
    })) as unknown as typeof fetch;

    const { container } = render(<PostMediaImage postId="p1" src="https://cdn/expired.jpg" />);
    const img = container.querySelector("img")!;

    fireEvent.error(img);

    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/fresh.jpg"));

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const urls = calls.map(([u]) => String(u));
    for (const u of urls) {
      expect(u).not.toMatch(/\/api\/feed/);
      expect(u).not.toMatch(/\/api\/posts\?/);
    }
    expect(urls).toEqual(["/api/posts/media"]);
    const body = JSON.parse(String((calls[0][1] as RequestInit).body));
    expect(body.postIds).toEqual(["p1"]);
  });

  it("stops after ONE retry — a second failure renders the placeholder, not a third request", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [{ postId: "p1", mediaUrl: "https://cdn/fresh.jpg" }],
          expiresAt: "x",
        },
      }),
    })) as unknown as typeof fetch;

    const { container } = render(<PostMediaImage postId="p1" src="https://cdn/expired.jpg" />);
    const first = container.querySelector("img")!;

    fireEvent.error(first);

    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/fresh.jpg"));
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Deliberately NO fireEvent.load between the two errors. That is the point:
    // a url that never renders never returns the budget, so a genuinely dead
    // url stays capped at one retry no matter how long the element lives.
    const second = container.querySelector("img")!;
    fireEvent.error(second);

    await waitFor(() => expect(container.querySelector("img")).toBeNull());

    // THE RETRY-CAP ASSERTION: still exactly one fetch — no second re-mint.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("div")).not.toBeNull();
  });

  it("falls back to the placeholder when the re-mint yields nothing", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [] } }),
    })) as unknown as typeof fetch;

    const { container } = render(<PostMediaImage postId="p1" src="https://cdn/expired.jpg" />);
    const img = container.querySelector("img")!;

    fireEvent.error(img);

    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("a 402 on the re-mint renders the placeholder, never gated bytes", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({ error: { code: "subscription_required" } }),
    })) as unknown as typeof fetch;

    const { container } = render(<PostMediaImage postId="p1" src="https://cdn/expired.jpg" />);
    const img = container.querySelector("img")!;

    fireEvent.error(img);

    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(container.querySelector("div")).not.toBeNull();
    // The gated branch is the one where disclosure would matter most: the
    // viewer must not learn WHY (expired vs forbidden vs missing all collapse
    // to the same silent placeholder).
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("a video poster re-mints from the playback route, not the post-media route", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { posterUrl: "https://cdn/fresh-poster.jpg" } }),
    })) as unknown as typeof fetch;

    const { container } = render(
      <PostMediaImage postId="p1" src="https://cdn/expired-poster.jpg" video />,
    );
    const img = container.querySelector("img")!;

    fireEvent.error(img);

    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/fresh-poster.jpg"));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    // `no-store` is asserted, not incidental: a cached poster would make the
    // single retry a guaranteed no-op and skip the server's re-gate.
    expect(global.fetch).toHaveBeenCalledWith("/api/posts/p1/playback?posterOnly=1", {
      cache: "no-store",
    });
  });

  it("renders the placeholder and never an img when there is no src", () => {
    global.fetch = vi.fn() as unknown as typeof fetch;

    const { container } = render(<PostMediaImage postId="p1" src={null} />);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("div")).not.toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// The unit tests above prove PostMediaImage's own behaviour. These prove the
// WIRING — that the card hands it the right post id and the right route. A
// wrong id here would not leak anything (the BFF re-authorises every mint), but
// it would silently no-op the entire fix in production while the suite stayed
// green, which is exactly the failure this ticket exists to end.
describe("PostCard — ENG-813 re-mint wiring", () => {
  const BASE: FeedPost = {
    id: "post-1",
    horseId: "horse-1",
    horseName: "Mahogany",
    trainerName: "Chris Waller",
    postedAgo: "2h ago",
    body: "Trackwork this morning.",
    media: { type: "photo", posterUrl: "https://cdn/expired.jpg" },
    watermarked: false,
    raceBadge: null,
    count: 12,
    reacted: null,
    bookmarked: false,
  };
  const noop = () => {};

  it("re-mints with the POST id, not the horse id", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { items: [{ postId: "post-1", mediaUrl: "https://cdn/fresh.jpg" }] },
      }),
    })) as unknown as typeof fetch;

    const { container } = render(
      <PostCard post={BASE} viewerId="v1" onReact={noop} onBookmark={noop} />,
    );
    const img = container.querySelector(".post-media-web img")!;
    expect(img).toBeInTheDocument();

    fireEvent.error(img);

    await waitFor(() =>
      expect(container.querySelector(".post-media-web img")?.getAttribute("src")).toBe(
        "https://cdn/fresh.jpg",
      ),
    );

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/api/posts/media");
    // `post-1`, never `horse-1` — the id a re-mint asks for is the POST's.
    expect(JSON.parse(String((init as RequestInit).body)).postIds).toEqual(["post-1"]);
  });

  it("routes a VIDEO card's poster to the playback route (the video flag is wired)", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { posterUrl: "https://cdn/fresh-poster.jpg" } }),
    })) as unknown as typeof fetch;

    const { container } = render(
      <PostCard
        post={{ ...BASE, media: { type: "video", posterUrl: "https://cdn/expired-poster.jpg" } }}
        viewerId="v1"
        onReact={noop}
        onBookmark={noop}
      />,
    );
    const img = container.querySelector(".post-media-web img")!;

    fireEvent.error(img);

    await waitFor(() =>
      expect(container.querySelector(".post-media-web img")?.getAttribute("src")).toBe(
        "https://cdn/fresh-poster.jpg",
      ),
    );

    expect(global.fetch).toHaveBeenCalledWith("/api/posts/post-1/playback?posterOnly=1", {
      cache: "no-store",
    });
  });

  it("still draws the plain placeholder, and never an img, when there is no poster", () => {
    global.fetch = vi.fn() as unknown as typeof fetch;

    const { container } = render(
      <PostCard
        post={{ ...BASE, media: { type: "photo", posterUrl: null } }}
        viewerId="v1"
        onReact={noop}
        onBookmark={noop}
      />,
    );

    const box = container.querySelector(".post-media-web")!;
    expect(box).not.toBeNull();
    expect(box.querySelector("img")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// The block above pins the happy paths. This one pins the machinery that had
// NO coverage: delete the same-url guard, the budget reset or the media-player
// wiring and the suite stayed green, which is how a "green suite, dead fix"
// ships. Each test here is paired with the mutation it catches.
describe("PostMediaImage — the uncovered machinery", () => {
  const mintOnce = (url: string) =>
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [{ postId: "p1", mediaUrl: url }] } }),
    })) as unknown as typeof fetch;

  // Catches: deleting `fresh === url` (post-media-image.tsx). Without it the
  // element keeps a url that already failed, so it never fires `error` again
  // and sits there broken instead of falling to the placeholder.
  it("treats a re-mint that returns the SAME url as no recovery", async () => {
    global.fetch = mintOnce("https://cdn/same.jpg");

    const { container } = render(<PostMediaImage postId="p1" src="https://cdn/same.jpg" />);
    fireEvent.error(container.querySelector("img")!);

    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // Catches: deleting the render-phase prop-sync or the useEffect budget reset.
  // A NEW url from the screen is a new generation and earns a fresh retry.
  it("a new src from the screen revives the element and restores its retry budget", async () => {
    global.fetch = mintOnce("https://cdn/mint-a.jpg");

    const { container, rerender } = render(
      <PostMediaImage postId="p1" src="https://cdn/expired-1.jpg" />,
    );
    fireEvent.error(container.querySelector("img")!);
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/mint-a.jpg"),
    );
    fireEvent.error(container.querySelector("img")!);
    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(global.fetch).toHaveBeenCalledTimes(1);

    global.fetch = mintOnce("https://cdn/mint-b.jpg");
    rerender(<PostMediaImage postId="p1" src="https://cdn/page-fresh.jpg" />);

    // Revived on the screen's url, not the placeholder.
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/page-fresh.jpg");

    fireEvent.error(container.querySelector("img")!);
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/mint-b.jpg"),
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // Catches: removing `setFailed(false)` before `setUrl(fresh)`. Two error
  // events racing one in-flight re-mint latch failed=true; the recovery then
  // lands and must un-latch it, or "retry once" degrades to "retry never".
  it("a burst of error events does not throw away a successful recovery", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    global.fetch = vi.fn(async () => {
      await gate;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { items: [{ postId: "p1", mediaUrl: "https://cdn/fresh.jpg" }] } }),
      };
    }) as unknown as typeof fetch;

    const { container } = render(<PostMediaImage postId="p1" src="https://cdn/expired.jpg" />);
    const img = container.querySelector("img")!;

    fireEvent.error(img); // claims the budget, then awaits the gate
    fireEvent.error(img); // races it: takes the retried branch, latches failed
    release(null);

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/fresh.jpg"),
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  // Catches: removing the generation guard. A stale re-mint resolving after the
  // screen delivered a newer url must not overwrite it — and a stale FAILURE
  // must not blank it, which would reintroduce the empty box outright.
  it("a stale in-flight re-mint never overwrites a newer url from the screen", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    global.fetch = vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
    }) as unknown as typeof fetch;

    const { container, rerender } = render(
      <PostMediaImage postId="p1" src="https://cdn/expired.jpg" />,
    );
    fireEvent.error(container.querySelector("img")!);

    rerender(<PostMediaImage postId="p1" src="https://cdn/page-fresh.jpg" />);
    release(null);
    await new Promise((r) => setTimeout(r, 0));

    // The stale null resolved AFTER the new src landed: it must be dropped.
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/page-fresh.jpg");
  });
});

// Catches: reverting media-player.tsx to a raw <img>. Preview-only today, but
// it renders post media and must recover the same way.
describe("MediaPlayer — ENG-813 re-mint wiring", () => {
  it("re-mints its poster through the playback route", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { posterUrl: "https://cdn/fresh-poster.jpg" } }),
    })) as unknown as typeof fetch;

    const { container } = render(
      <MediaPlayer postId="post-9" posterUrl="https://cdn/expired-poster.jpg" duration="1:12" />,
    );
    fireEvent.error(container.querySelector("img")!);

    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "https://cdn/fresh-poster.jpg",
      ),
    );
    expect(global.fetch).toHaveBeenCalledWith("/api/posts/post-9/playback?posterOnly=1", {
      cache: "no-store",
    });
  });
});

// Recovery has to survive REPEATED expiry, not just the first one. A minted url
// lives 300s, so a tab left open long enough expires over and over; a budget
// that never came back would fix minute 5 and then sit on a permanent
// placeholder — the same empty box the ticket set out to remove.
describe("PostMediaImage — durability across repeated expiry", () => {
  it("recovers from a SECOND expiry, not just the first", async () => {
    let minted = 0;
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { items: [{ postId: "p1", mediaUrl: `https://cdn/mint-${++minted}.jpg` }] },
      }),
    })) as unknown as typeof fetch;

    const { container } = render(<PostMediaImage postId="p1" src="https://cdn/expired-0.jpg" />);

    // Minute 5 — the page's url expires and is recovered.
    fireEvent.error(container.querySelector("img")!);
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/mint-1.jpg"),
    );
    // The recovered image actually paints. THIS is what returns the budget.
    fireEvent.load(container.querySelector("img")!);

    // Minute 10 — the re-minted url expires too. It must recover again.
    fireEvent.error(container.querySelector("img")!);
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/mint-2.jpg"),
    );
    fireEvent.load(container.querySelector("img")!);

    // Minute 15 — still recovering. Durable, not one-shot.
    fireEvent.error(container.querySelector("img")!);
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/mint-3.jpg"),
    );

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(container.querySelector("img")).not.toBeNull();
  });

  it("a url that renders then dies for good still stops after ONE retry", async () => {
    // The storm guarantee, restated against the reset: painting once returns
    // the budget, but the url that replaces it never paints, so it spends that
    // budget once and terminates. One failed request per successful render.
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [{ postId: "p1", mediaUrl: "https://cdn/dead.jpg" }] } }),
    })) as unknown as typeof fetch;

    const { container } = render(<PostMediaImage postId="p1" src="https://cdn/painted.jpg" />);
    fireEvent.load(container.querySelector("img")!);

    fireEvent.error(container.querySelector("img")!);
    await waitFor(() =>
      expect(container.querySelector("img")?.getAttribute("src")).toBe("https://cdn/dead.jpg"),
    );

    // The replacement never loads. Every further error must be terminal.
    fireEvent.error(container.querySelector("img")!);
    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
