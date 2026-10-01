// The member content skeleton (ENG-1593): what paints inside the shell while a
// member screen's data is still loading.
//
// It is the SAME placeholder ExploreFeed already drew on its own while page 1
// loaded (two `post-web` blocks on `--line`), inside the same topbar +
// feed-grid frame, so the swap to real cards moves nothing on screen. Used by
// `./loading.tsx` (every member route) and by the Explore page's own Suspense
// boundary around its server-rendered first page.
//
// Server component, no directive and no state: it is pure markup, rendered
// before any data exists, so it can never carry member content.
export function FeedSkeleton({ title }: { title?: string }) {
  return (
    <>
      <div className="topbar">
        {title ? (
          <h1 className="section-title-web" style={{ margin: 0 }}>{title}</h1>
        ) : (
          <div aria-hidden="true" style={{ width: 120, height: 28, borderRadius: 8, background: "var(--line)" }} />
        )}
        <div className="topbar-spacer" />
        {/* Invisible stand-ins for the search pill + bell, so the topbar keeps
            its real height and the swap to content does not shift the page. */}
        <div className="topbar-search" aria-hidden="true" style={{ visibility: "hidden" }}>{"\u00a0"}</div>
        <div className="topbar-bell" aria-hidden="true" style={{ visibility: "hidden" }} />
      </div>
      <div className="feed-grid" aria-busy="true">
        <div className="feed-col">
          <div className="post-web" aria-hidden="true" style={{ height: 260, background: "var(--line)" }} />
          <div className="post-web" aria-hidden="true" style={{ height: 260, background: "var(--line)" }} />
        </div>
        <div className="feed-aside" />
      </div>
    </>
  );
}
