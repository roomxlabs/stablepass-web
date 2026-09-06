// ENG-961 — the shared bookmark bus that keeps the five feed screens in sync.
// Mirrors stablepass-mobile's `subscribeBookmarkChanges` contract.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitBookmarkChange,
  resetBookmarkListeners,
  subscribeBookmarkChanges,
} from "@/lib/feed/bookmark-store";

beforeEach(() => resetBookmarkListeners());

describe("bookmark store", () => {
  it("delivers a change to every subscriber", () => {
    const explore = vi.fn();
    const saved = vi.fn();
    const following = vi.fn();
    subscribeBookmarkChanges(explore);
    subscribeBookmarkChanges(saved);
    subscribeBookmarkChanges(following);

    emitBookmarkChange("post-1", true);

    for (const l of [explore, saved, following]) {
      expect(l).toHaveBeenCalledExactlyOnceWith("post-1", true);
    }
  });

  it("stops delivering after unsubscribe (an unmounted screen)", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBookmarkChanges(listener);
    emitBookmarkChange("post-1", true);
    unsubscribe();
    emitBookmarkChange("post-2", false);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("post-1", true);
  });

  it("unsubscribe is idempotent", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBookmarkChanges(listener);
    unsubscribe();
    unsubscribe();
    emitBookmarkChange("post-1", true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("carries the unsave direction too", () => {
    const listener = vi.fn();
    subscribeBookmarkChanges(listener);
    emitBookmarkChange("post-9", false);
    expect(listener).toHaveBeenCalledWith("post-9", false);
  });

  // A screen unmounting inside its own notification must not corrupt the
  // iteration (the reason emit copies the set before looping).
  it("survives a listener unsubscribing mid-emit", () => {
    const second = vi.fn();
    let off: () => void = () => {};
    const first = vi.fn(() => off());
    off = subscribeBookmarkChanges(first);
    subscribeBookmarkChanges(second);

    expect(() => emitBookmarkChange("post-1", true)).not.toThrow();
    expect(second).toHaveBeenCalledWith("post-1", true);
  });

  it("an emit with no subscribers is a no-op", () => {
    expect(() => emitBookmarkChange("post-1", true)).not.toThrow();
  });
});
