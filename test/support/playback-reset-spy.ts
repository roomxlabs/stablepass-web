// Observe `useFeedPlayback().reset()` from a feed component test (ENG-1633).
//
//   vi.mock("@/lib/feed/use-feed-playback", async (importOriginal) =>
//     (await import("./support/playback-reset-spy")).withResetSpy(await importOriginal()));
//
// The real hook runs unchanged; only `reset` is wrapped so each call also hits
// `resetSpy`. The wrapper is memoised on the real `reset` (which is stable), so
// a feed whose `fetchPage` depends on it does not re-fetch on every render.
import { useMemo } from "react";
import { vi } from "vitest";
import type * as PlaybackModule from "@/lib/feed/use-feed-playback";

export const resetSpy = vi.fn();

export function withResetSpy(mod: typeof PlaybackModule): typeof PlaybackModule {
  function useFeedPlayback() {
    const real = mod.useFeedPlayback();
    const realReset = real.reset;
    const reset = useMemo(
      () => () => {
        resetSpy();
        realReset();
      },
      [realReset],
    );
    return useMemo(() => ({ ...real, reset }), [real, reset]);
  }
  return { ...mod, useFeedPlayback };
}
