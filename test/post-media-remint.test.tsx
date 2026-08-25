import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { PostMediaImage } from "@/components/post-media-image";
import { PostCard } from "@/components/post-card";
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

    expect(() => fireEvent.error(img)).not.toThrow();

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
