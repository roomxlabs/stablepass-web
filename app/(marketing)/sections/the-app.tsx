/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */

/**
 * Section 4 — `section#app.sec`, "The stablepass. app" (ENG-588 / W2).
 *
 * Nav target for "The app".
 *
 * The ticket's summary table calls this "four labelled app screenshots"; the
 * signed-off mockup actually pairs FOUR labelled feature chips (`.app-feats`)
 * with TWO device shots (`.stage`: the phone and the laptop). The mockup is the
 * design source, so that is what ships. The eight labelled app screenshots the
 * table is thinking of live in section 5's `.mem-apps` row.
 *
 * Both shots are the extracted assets W1 put in public/marketing/, never
 * re-embedded data URIs.
 */

const FEATURES = [
  {
    label: "Photos & videos",
    path: (
      <>
        <rect x="3" y="7" width="18" height="13" rx="2" />
        <circle cx="12" cy="13.5" r="3.5" />
        <path d="M8.5 7 10 4h4l1.5 3" />
      </>
    ),
  },
  {
    label: "Race previews",
    path: (
      <>
        <path d="M5 21V4" />
        <path d="M5 5c4.5-2.4 8 2.2 14 .3V14c-6 1.9-9.5-2.7-14-.3" />
      </>
    ),
  },
  {
    label: "Progress updates",
    path: (
      <>
        <path d="M3 17l6-6 4 4 8-8" />
        <path d="M15 7h6v6" />
      </>
    ),
  },
  {
    label: "Subscriber-only content",
    path: <path d="m12 3 2.6 5.6 6.1.7-4.5 4.1 1.3 6-5.5-3.1-5.5 3.1 1.3-6L3.3 9.3l6.1-.7Z" />,
  },
];

export default function TheApp() {
  return (
    <section className="sec" id="app">
      <div className="wrap">
        <div className="app-panel rv" suppressHydrationWarning>
          <div className="oval" aria-hidden="true" />
          <div className="app-head">
            <span className="eyebrow" style={{ color: "#EDD9A8" }}>
              The stablepass. app
            </span>
            <h2>Behind-the-scenes racing, made simple.</h2>
            <p>
              Follow selected horses and get the story straight from the stable: photos, videos, race previews and
              results, all in one clean feed.
            </p>
            <div className="app-feats">
              {FEATURES.map((feature) => (
                <span key={feature.label}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {feature.path}
                  </svg>
                  {feature.label}
                </span>
              ))}
            </div>
          </div>
          <div className="stage">
            <div className="phone ph-stage">
              <div className="ph-view">
                <span className="ph-island" />
                <img
                  className="shot"
                  src="/marketing/3398990e.jpg"
                  alt="stablepass app: the horses you follow, with the next runner"
                />
                <span className="ph-home" />
              </div>
            </div>
            <div className="laptop">
              <div className="lap-screen">
                <span className="lap-cam" />
                <div className="lap-view">
                  <img
                    className="shot"
                    src="/marketing/4a5f34ce.jpg"
                    alt="stablepass subscriber portal: Mahogany horse profile"
                  />
                </div>
              </div>
              <div className="lap-base" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
