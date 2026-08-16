/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */

/**
 * Section 5 — `section#members.sec`, "What subscribers get" (ENG-588 / W2).
 *
 * Two halves, both from the mockup:
 *  - `.tiles` — four landscape crops. Hovering (or focusing, hence `tabIndex`)
 *    fills a tile green and reveals its sentence. That is pure CSS in
 *    marketing.css, so it survives with scripting off.
 *  - `.mem-apps` — the eight subscription screens, shown as the actual app
 *    screens rather than a checklist.
 *
 * The `[data-ma]` arrows ship here but are INERT until W3 (ENG-589). They are
 * part of W3's declared DOM contract: its marquee driver binds them with an
 * event delegate and never edits this file. Rendering them now keeps the section
 * visually faithful and keeps W3's diff to the swap it declared.
 *
 * On a phone the mockup's media query turns `.ma-scroll` into a native
 * `overflow-x:auto` swipe lane, so the row is reachable without any JS at all.
 */

const TILES = [
  {
    src: "/marketing/f10610fb.jpg",
    alt: "Trainer Rob Heathcote with a horse in the stalls at Eagle Farm",
    title: "Follow real horses",
    body: "Receive updates from stables as your selected horses progress through training, trials, jump outs, race days and more.",
  },
  {
    src: "/marketing/6ec6412f.jpg",
    alt: "Riders and stable staff working through the morning in the stable",
    title: "Go behind the scenes",
    body: "See stable updates, trackwork, race build up, and moments from daily stable life.",
  },
  {
    src: "/marketing/a2f69179.jpg",
    alt: "A trackwork rider leaving the barriers while a stable staff member watches on",
    title: "The people behind it",
    body: "Find out more about the trainers, the stable staff and the people who work with the horses every day.",
  },
  {
    src: "/marketing/276f4bc3.jpg",
    alt: "A jockey in silks in the mounting yard before the race",
    title: "Feel more connected",
    body: "Enjoy the excitement of race days with more context, more stories, and more reasons to follow each horse and stable.",
  },
];

const APP_SCREENS = [
  {
    src: "/marketing/2abf5618.jpg",
    alt: "stablepass app: a written update posted by the trainer",
    caption: "Stable updates",
  },
  {
    src: "/marketing/1c515ac1.jpg",
    alt: "stablepass app: a photo update posted from the stable",
    caption: "Photos from the stable",
  },
  {
    src: "/marketing/df701113.jpg",
    alt: "stablepass app: a trackwork update with the morning's gallop times",
    caption: "Training & trackwork",
  },
  {
    src: "/marketing/8c0fa420.jpg",
    alt: "stablepass app: the horses you follow and where each one is up to",
    caption: "Horse progress reports",
  },
  {
    src: "/marketing/daa70248.jpg",
    alt: "stablepass app: horse profile with the next race card",
    caption: "Race previews",
  },
  {
    src: "/marketing/42017d50.jpg",
    alt: "stablepass app: a short video posted from the stable",
    caption: "Videos & short clips",
  },
  {
    // v2.7 asset: this screen's third stat tile reads 57.5kg / WEIGHT. The v2.6
    // asset showed a market price there, which guardrail #8 does not allow to be
    // rendered as product UI. Do not "restore" the older file to match the live
    // preview, which is still serving v2.6.
    src: "/marketing/3334430f.jpg",
    alt: "stablepass app: a race result with the stable's post-race comment",
    caption: "Post-race comments",
  },
  {
    src: "/marketing/27c52a38.jpg",
    alt: "stablepass app: race day alerts for the horses you follow",
    caption: "Race day alerts",
  },
];

export default function SubscribersGet() {
  return (
    <section className="sec" id="members" style={{ paddingTop: 40 }}>
      <div className="wrap">
        <div className="sec-head center rv" suppressHydrationWarning>
          <span className="eyebrow">What subscribers get</span>
          <h2>Inside your subscription</h2>
          <p className="lead">
            stablepass. subscribers receive access to racing content designed to bring the sport to life. Follow real
            horses through training, trials, race days and spelling, go behind the scenes with the stables, and enjoy
            simple monthly access with no complex contracts or racing paperwork.
          </p>
        </div>

        {/* landscape crops; hovering a tile fills it green and reveals the sentence */}
        <div className="tiles rv" suppressHydrationWarning>
          {TILES.map((tile) => (
            <figure className="tile" tabIndex={0} key={tile.title}>
              <img src={tile.src} alt={tile.alt} />
              <figcaption>
                <i />
                {tile.title}
              </figcaption>
              <div className="t-over">
                <b>{tile.title}</b>
                <p>{tile.body}</p>
              </div>
            </figure>
          ))}
        </div>

        {/* The eight things a subscription delivers, each shown as the actual screen rather than
            a checklist with hover popups. W3 makes it scroll; the arrows below are its handles. */}
        <div className="mem-apps rv" suppressHydrationWarning id="mem-apps">
          <p className="ma-lead">
            Every update lands in the same clean feed on the app, whether it is a video from morning trackwork, the
            trainer preview before a run, or the jockey debrief after a race.
          </p>
          <div className="ma-scroll">
            <div className="ma-row">
              {APP_SCREENS.map((screen) => (
                <figure className="ma" key={screen.caption}>
                  <div className="phone">
                    <div className="ph-view">
                      <span className="ph-island" />
                      <img className="shot" src={screen.src} alt={screen.alt} />
                      <span className="ph-home" />
                    </div>
                  </div>
                  <figcaption>{screen.caption}</figcaption>
                </figure>
              ))}
            </div>
          </div>
          <div className="ma-ctrl">
            <button type="button" data-ma="-1" aria-label="Previous screen">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M15 5 8 12l7 7" />
              </svg>
            </button>
            <button type="button" data-ma="1" aria-label="Next screen">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m9 5 7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
