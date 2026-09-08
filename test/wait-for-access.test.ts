import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForEntitled } from "@/lib/api/wait-for-access";

describe("waitForEntitled", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns true on the first 200 from /api/feed", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(waitForEntitled({ timeoutMs: 2_000, intervalMs: 100 })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/feed?limit=1",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("keeps polling through 402 until the feed is open", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 402 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    const pending = waitForEntitled({ timeoutMs: 2_000, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns false immediately on 401 and does not keep polling", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(waitForEntitled({ timeoutMs: 2_000, intervalMs: 100 })).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns false when the timeout elapses still gated", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 402 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = waitForEntitled({ timeoutMs: 250, intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toBe(false);
  });
});
