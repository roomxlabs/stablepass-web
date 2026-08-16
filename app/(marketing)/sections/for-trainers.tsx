/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */

/**
 * Section 11 — `section#trainers.sec.train-band.train`, the partner pitch
 * (ENG-588 / W2).
 *
 * Nav target for "For trainers". The longest section on the page: the lead, the
 * dark "why partner" panel with the shareable content types, the five-step flow,
 * the six numbered benefits, and the closing note.
 *
 * Both "Partner with stablepass." buttons carry `data-sheet="contact"` and
 * `data-subject="Trainer partnerships"`, and are INERT here. W3 (ENG-589) turns
 * them into a `mailto:` composed from that subject — a real mail client, not a
 * form that pretends to send. Rendering the attributes now means W3 binds a
 * delegate and never edits this file.
 */

const SHARE_CHIPS = [
  "Stable photos",
  "Short videos",
  "Horse updates",
  "Trackwork notes",
  "Race plans",
  "Trial updates",
  "Race day comments",
  "General stable news",
  "Educational racing insights",
];

const FLOW = [
  "Nominate a horse for stablepass. subscribers to follow",
  "Share regular stable updates, photos, or videos",
  "stablepass. presents the content to subscribers",
  "Racing fans get closer to the journey",
  "Your stable gains extra exposure",
];

const BENEFITS = [
  "Promote your stable to new racing fans",
  "Build a stronger public profile",
  "Showcase your team and horses",
  "Share the story behind the racing result",
  "Support greater engagement in the sport",
  "Keep the process simple and low effort",
];

export default function ForTrainers() {
  return (
    <section className="sec train-band train" id="trainers">
      <span className="tp-mark" aria-hidden="true">
        S
      </span>
      <div className="wrap">
        <div className="tp-head rv" suppressHydrationWarning>
          <div className="tp-lead">
            <span className="eyebrow">For trainers</span>
            <h2>Partner with stablepass.</h2>
            <p>
              stablepass. helps trainers and stables reach a wider racing audience through simple content sharing.
            </p>
            <p>
              We are building a racing experience subscription that introduces more people to the stories, horses, and
              people behind thoroughbred racing.
            </p>
            <button className="btn btn-green" type="button" data-sheet="contact" data-subject="Trainer partnerships">
              Partner with stablepass.
            </button>
          </div>
          <figure className="tp-photo">
            <img
              src="/marketing/c2e504a3.jpg"
              alt="A trainer congratulates the jockey after the race"
              width={900}
              height={945}
            />
          </figure>
        </div>

        {/* the dark anchor: why partner, with the shareable content types as the evidence */}
        <div className="tp-panel rv" suppressHydrationWarning>
          <div className="oval" aria-hidden="true" />
          <div className="tp-panel-in">
            <div className="tp-panel-copy">
              <span className="eyebrow" style={{ color: "#EDD9A8" }}>
                Why partner
              </span>
              <h3>Another way to promote your stable.</h3>
              <p>
                stablepass. gives trainers another way to promote their stable, their horses, and their team to a
                broader audience of racing fans.
              </p>
              <p className="tp-pull">There is no need to create complicated new content.</p>
              <p>
                Participating stables can share the types of updates they already prepare, such as horse progress,
                stable photos, short videos, race plans, and post-race comments.
              </p>
            </div>
            <div className="tp-panel-share">
              <span className="tp-share-k">Content trainers can share</span>
              <div className="tp-chips">
                {SHARE_CHIPS.map((chip) => (
                  <span key={chip}>{chip}</span>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="tp-flow-head rv" suppressHydrationWarning>
          <span className="eyebrow">How it works for trainers</span>
        </div>
        <ol className="tp-flow rv" suppressHydrationWarning>
          {FLOW.map((step, i) => (
            <li key={step}>
              <span className="cloth">{i + 1}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>

        <div className="tp-ben-head rv" suppressHydrationWarning>
          <span className="eyebrow">Benefits for trainers</span>
        </div>
        <ul className="tp-ben rv" suppressHydrationWarning>
          {BENEFITS.map((benefit, i) => (
            <li key={benefit}>
              <i>{String(i + 1).padStart(2, "0")}</i>
              {benefit}
            </li>
          ))}
        </ul>

        <div className="tp-close rv" suppressHydrationWarning>
          <div className="tp-close-oval" aria-hidden="true" />
          <h3>A simple partnership</h3>
          <p>
            stablepass. is designed to be easy for trainers. We are not asking stables to take on a major new
            workload.
          </p>
          <p>
            The goal is simple: share racing stories with a wider audience and help more people feel connected to the
            sport and your stable.
          </p>
          <button className="btn btn-green" type="button" data-sheet="contact" data-subject="Trainer partnerships">
            Partner with stablepass.
          </button>
        </div>
      </div>
    </section>
  );
}
