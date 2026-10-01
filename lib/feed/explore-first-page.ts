// Server-rendered page 1 of /explore (ENG-1593).
//
// Before this, the member got an empty shell, then hydration, then `/api/feed`,
// then identity, then media — five serial hops before the first image request.
// Now the server makes the same calls the BFF would, AS THE MEMBER, and the
// first cards (with their minted image urls) are in the HTML itself.
//
// THE GATE IS UNCHANGED. The rows come from the be `feed` edge function, called
// with the member's own JWT — the same function, and so the same 402 content
// gate, that `/api/feed` relays. A lapsed member gets `{ kind: "gated" }` and
// NOTHING else: no rows, and the media mint is never reached. The mint re-gates
// on its own as well (`edgePostMediaTransport`).
//
// NEVER CACHED. The result is per-member, signed and short-lived; it is built
// inside a dynamic (cookie-reading) render and handed straight to the page. Do
// not wrap it in "use cache" / `unstable_cache` or move it into anything static:
// that would serve one member's signed urls to another.
//
// A FAILURE IS NOT A WALL. Anything that is not a clean page or a 402 returns
// `null`, and the ExploreFeed island then fetches page 1 itself through the BFF
// exactly as it always did — the server render is an accelerator, never the
// only way to see the feed. Known cost of that fallback: the edge `feed` call
// above has already recorded impressions for the rows it served, so after a
// failed ASSEMBLY (not a failed feed call) the client's page 1 starts with the
// next unseen rows and those first rows resurface in the seen backlog below.
// Rare (it needs the identity read to be rejected) and self-healing.
import { edgeFetch } from "@/lib/api/edge";
import { resolvePostDisplayUrls } from "@/lib/api/post-media";
import { edgePostMediaTransport } from "@/lib/api/post-media-server";
import { assembleExplorePage, EXPLORE_PAGE_SIZE, type ExploreInitialPage } from "@/lib/feed/explore-page";
import type { PostIntrinsicRow } from "@/lib/feed/post-row";
import { supabaseServer } from "@/lib/supabase/server";

export async function loadExploreFirstPage(): Promise<ExploreInitialPage | null> {
  try {
    const sb = await supabaseServer();
    // Same query `/api/feed` forwards for a first page: no cursor, and never
    // `shares=` (Explore omits for-sale posts — ENG-831).
    const res = await edgeFetch(sb, `feed?${new URLSearchParams({ limit: String(EXPLORE_PAGE_SIZE) })}`);
    if (res.status === 402) return { kind: "gated" };
    if (!res.ok) return null;

    const body = await res.json();
    const rows = (body?.data ?? []) as PostIntrinsicRow[];
    const meta = (body?.meta ?? {}) as { nextCursor?: string | null; hasMore?: boolean };

    const transport = edgePostMediaTransport(sb);
    const page = await assembleExplorePage(sb, rows, (r) => resolvePostDisplayUrls(r, transport));
    if (page.kind === "gated") return { kind: "gated" };
    if (page.kind === "error") return null;
    return {
      kind: "ok",
      posts: page.posts,
      nextCursor: meta.nextCursor ?? null,
      hasMore: Boolean(meta.hasMore),
    };
  } catch (e) {
    console.error("explore first page: server render failed, falling back to the client fetch", e);
    return null;
  }
}
