import { useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";

/**
 * use-feed-video-failure — the ONE fatal-transport handler the five member
 * feeds share (ENG-1063, extracted from the verbatim copy that lived in
 * explore-feed, following-screen, saved-feed, horse-posts and trainer-posts).
 *
 * WHY THIS EXISTS. `HlsVideo`'s `onFatalError` body was byte-identical in all
 * five call sites — two `setState` shapes plus the comment explaining them.
 * Nothing was wrong with it, but a copy of a rule is a rule that desyncs: edit
 * the pill copy or either state shape in one feed and the other four keep the
 * old behaviour, with a fully green suite (the guard in
 * test/feed-hls-video.test.tsx pins the *import* and the no-`autoPlay` rule,
 * not the handler body). One definition, five consumers, one place to change.
 *
 * The behaviour is unchanged and deliberately narrow — see `HlsVideoProps.
 * onFatalError` in components/hls-video.tsx for what does and does not reach
 * here (a non-fatal hls.js error and a declined autoplay must NOT).
 *
 * @param setPlaying   the feed's `playing` map (postId → minted playback url)
 * @param setPlayError the feed's `playError` map (postId → show the pill)
 * @returns `onFatalVideo(postId)` — call it from `onFatalError`
 */
export function useFeedVideoFailure(
  setPlaying: Dispatch<SetStateAction<Record<string, string>>>,
  setPlayError: Dispatch<SetStateAction<Record<string, boolean>>>,
): (postId: string) => void {
  return useCallback(
    (postId: string) => {
      // A dead transport must not leave a black rectangle. Drop this post out
      // of `playing` so the player unmounts, and raise `playError` so the card
      // falls back to its poster plus the SAME "Couldn't load the video." pill
      // a failed mint already produces (ENG-1059).
      //
      // `delete` on a COPY, not `{ ...prev, [postId]: undefined }`: the feeds
      // render a player for `playing[p.id]` being truthy, and an own key whose
      // value is `undefined` would still be an own key — harmless here, but the
      // map is also spread into other reads, so keep it genuinely absent.
      setPlaying((prev) => {
        const next = { ...prev };
        delete next[postId];
        return next;
      });
      setPlayError((prev) => ({ ...prev, [postId]: true }));
    },
    [setPlaying, setPlayError],
  );
}
