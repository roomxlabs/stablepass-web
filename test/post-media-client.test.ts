import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchPostMedia, resolvePostDisplayUrls, PostMediaError } from "@/lib/api/post-media";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("fetchPostMedia", () => {
  it("returns a postId → url Map from items", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          items: [
            { postId: "p1", mediaUrl: "https://signed.test/p1?token=a" },
            { postId: "p2", mediaUrl: "https://signed.test/p2?token=b" },
          ],
          expiresAt: "x",
        },
      }),
    })) as unknown as typeof fetch;

    const map = await fetchPostMedia(["p1", "p2", "p1"]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("/api/posts/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postIds: ["p1", "p2"] }),
    });
    expect(map.get("p1")).toBe("https://signed.test/p1?token=a");
    expect(map.get("p2")).toBe("https://signed.test/p2?token=b");
  });

  it("omits an id the server omitted — no existence leak", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { items: [{ postId: "p1", mediaUrl: "https://signed.test/p1?token=a" }], expiresAt: "x" },
      }),
    })) as unknown as typeof fetch;

    const map = await fetchPostMedia(["p1", "draft-1"]);
    expect(map.has("draft-1")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("surfaces 402 as PostMediaError gated — never a silent empty map", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 402,
      json: async () => ({ error: { code: "subscription_required" } }),
    })) as unknown as typeof fetch;

    await expect(fetchPostMedia(["p1"])).rejects.toMatchObject({
      name: "PostMediaError",
      reason: "gated",
    });
    expect(PostMediaError).toBeDefined();
  });

  it("a 500 yields an empty Map without throwing", async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: "post_media_failed" } }),
    })) as unknown as typeof fetch;

    await expect(fetchPostMedia(["p1"])).resolves.toEqual(new Map());
  });

  it("chunks at 50", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `p${i}`);
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { items: [], expiresAt: "x" } }),
    })) as unknown as typeof fetch;

    await fetchPostMedia(ids);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]?.body));
    const second = JSON.parse(String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1]?.body));
    expect(first.postIds).toHaveLength(50);
    expect(second.postIds).toHaveLength(1);
  });
});

describe("resolvePostDisplayUrls", () => {
  it("passes absolute URLs through keyed by post id", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const map = await resolvePostDisplayUrls([
      { id: "p1", type: "photo", media_url: "https://placehold.co/x", poster_url: null },
    ]);
    expect(map.get("p1")).toBe("https://placehold.co/x");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("mints video posters via playback?posterOnly=1", async () => {
    global.fetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/playback?posterOnly=1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { posterUrl: "https://signed.test/poster?token=z" } }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const map = await resolvePostDisplayUrls([
      { id: "v1", type: "video", poster_url: "posters/v1.jpg", media_url: null },
    ]);
    expect(map.get("v1")).toBe("https://signed.test/poster?token=z");
    expect(global.fetch).toHaveBeenCalledWith("/api/posts/v1/playback?posterOnly=1");
  });

  it("skips voice with no poster (no mint)", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    const map = await resolvePostDisplayUrls([
      { id: "voice-1", type: "voice", poster_url: null, media_url: "voice/a.m4a" },
    ]);
    expect(map.size).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
