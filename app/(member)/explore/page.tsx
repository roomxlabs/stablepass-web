// Explore feed (06-explore.html). MINIMAL placeholder for W1 (auth shell) so the
// member shell has something to render — W6 replaces this with the real feed.
export const metadata = { title: "Explore · StablePass" };

export default function ExplorePage() {
  return (
    <>
      <div className="topbar">
        <div className="feed-tabs">
          <button className="feed-tab active" type="button">Explore</button>
          <button className="feed-tab" type="button">Following</button>
        </div>
        <div className="topbar-spacer" />
        <div className="topbar-search">Search horses, trainers…</div>
        <div className="topbar-bell" />
      </div>

      <div className="page-pad">
        <h2>Your feed is coming together.</h2>
      </div>
    </>
  );
}
