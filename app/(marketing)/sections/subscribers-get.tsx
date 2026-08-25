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
 * The `.ma-scroll` row and its `[data-ma]` arrows now live in
 * `app-screens-carousel.tsx`. W2 shipped them here inert on the contract that
 * W3 (ENG-589) would bind them; W3 wired only the trainer strip, so they reached
 * production dead. The cards, the duplicate set and the arrows all have to be
 * rendered by the component that measures them, exactly as with the trainers,
 * so this file keeps the shell and hands the screens over.
 *
 * On a phone the mockup's media query turns `.ma-scroll` into a native
 * `overflow-x:auto` swipe lane, so the row is reachable without any JS at all.
 * A desktop pointer with scripting off is NOT covered: the mockup has no
 * `.ma-scroll.is-static` rule, so the row stays clipped there. Left as-is
 * on purpose — see the note in `test/marketing-app-screens.test.tsx`.
 */

import AppScreensCarousel, { type AppScreen } from "../app-screens-carousel";

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

const APP_SCREENS: AppScreen[] = [
  {
    src: "/marketing/49dc49c5.jpg",
    alt: "stablepass app: a written update posted by the trainer",
    caption: "Stable updates",
  },
  {
    src: "/marketing/ff7c4249.jpg",
    alt: "stablepass app: a photo update posted from the stable",
    caption: "Photos from the stable",
  },
  {
    src: "/marketing/806ed732.jpg",
    alt: "stablepass app: trackwork updates posted from the morning's work",
    caption: "Training & trackwork",
  },
  {
    src: "/marketing/33c5e035.jpg",
    alt: "stablepass app: the horses you follow and where each one is up to",
    caption: "Horse progress reports",
  },
  {
    src: "/marketing/20c7ef86.jpg",
    alt: "stablepass app: horse profile with the next race card",
    caption: "Race previews",
  },
  {
    src: "/marketing/f5da4f66.jpg",
    alt: "stablepass app: a short video posted from the stable",
    caption: "Videos & short clips",
  },
  {
    // GUARDRAIL #8 SLOT. This screen's stats tile reads starts / wins / places /
    // prizemoney — career figures, no market price anywhere on it. A withdrawn
    // v2.6 asset once showed a price in that tile, which guardrail #8 does not
    // allow to be rendered as product UI; v2.7 replaced it with weight and
    // ENG-732 re-cut it from the real app. Whatever this slot is pointed at next
    // has to be vetted the same way, and two tests pin this exact file by name.
    src: "/marketing/626b12ea.jpg",
    alt: "stablepass app: a race result with the stable's post-race comment",
    caption: "Post-race comments",
  },
  {
    src: "/marketing/e3a237ed.jpg",
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
          <AppScreensCarousel screens={APP_SCREENS} />
        </div>
      </div>
    </section>
  );
}
