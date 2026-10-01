// Explore feed (06-explore.html). Server component.
//
// ENG-1593 — page 1 is SERVER-RENDERED. The (member) layout has already
// verified the session (lib/auth/viewer.ts, `cache()`d, so the call below is
// free) and read the subscription (`readSubscriptionState`, `cache()`d, same).
// This page then streams in two steps:
//   1. immediately: the shell + the skeleton (the Suspense fallback below);
//   2. once the feed resolves: the real first cards, WITH their minted image
//      urls in the HTML, so the browser requests the first photo while it is
//      still parsing — not after hydration → /api/feed → identity → media.
// The ExploreFeed island keeps owning pagination, reactions, bookmarks, follow
// and the aside; it just starts from the rows it is handed.
import { Suspense } from "react";
import { getViewer } from "@/lib/auth/viewer";
import { readSubscriptionState } from "@/lib/api/subscription-state";
import { loadExploreFirstPage } from "@/lib/feed/explore-first-page";
import type { ExploreInitialPage } from "@/lib/feed/explore-page";
import { FeedSkeleton } from "../feed-skeleton";
import { ExploreFeed } from "./explore-feed";
import { PostPayUnlock } from "./post-pay-unlock";

export const metadata = { title: "Explore · StablePass" };

export default async function ExplorePage() {
  const user = await getViewer();

  // ENG-585: resolved HERE, on the server, and handed down as a BOOLEAN — the
  // wall's copy branches on whether this member has ever paid us, and
  // `stripe_customer_id` itself must never reach client JS (.rx/guardrails.md #1).
  const { everSubscribed, entitled } = await readSubscriptionState(user!.id);

  return (
    <>
      <Suspense fallback={null}>
        <PostPayUnlock />
      </Suspense>
      <Suspense fallback={<FeedSkeleton title="Explore" />}>
        <ExploreFirstPage viewerId={user!.id} everSubscribed={everSubscribed} entitled={entitled} />
      </Suspense>
    </>
  );
}

async function ExploreFirstPage({
  viewerId,
  everSubscribed,
  entitled,
}: {
  viewerId: string;
  everSubscribed: boolean;
  entitled: boolean;
}) {
  // A member the shared rule already says is NOT entitled gets the wall
  // straight away: no edge call is made, so no row and no media url can be
  // minted for them on this path at all (guardrail 3). An entitled member goes
  // through the edge `feed` gate, which has the final word — its 402 is also
  // the wall.
  //
  // `null` (the server render failed for a reason other than the gate) hands
  // ExploreFeed nothing, and it fetches page 1 through the BFF as it always did.
  const initialPage: ExploreInitialPage | null = entitled ? await loadExploreFirstPage() : { kind: "gated" };
  return <ExploreFeed viewerId={viewerId} everSubscribed={everSubscribed} initialPage={initialPage} />;
}
