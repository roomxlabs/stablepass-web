/* eslint-disable @next/next/no-img-element -- ENG-587 decision 6: the mockup sizes
   every image with CSS and next/image changes that layout behaviour. */

/**
 * Section 7 — `section.sec.why`, "Why stablepass." (ENG-588 / W2).
 *
 * The mirror of section 2: same `.duo` grid, copy first this time. The eyebrow
 * carries an inline gold colour in the mockup because `.why` is a dark band and
 * the shared `.eyebrow` rule is tuned for the light one.
 */
export default function Why() {
  return (
    <section className="sec why">
      <div className="wrap duo rv" suppressHydrationWarning>
        <div className="duo-copy">
          <span className="eyebrow" style={{ color: "#EDD9A8" }}>
            Why stablepass.
          </span>
          <h2>More than race day.</h2>
          <p>Most racing fans only see the horse on race day.</p>
          <p>
            stablepass. brings you closer to the full story: the early mornings, the stable updates, the build-up, the
            setbacks, the excitement, and the people who make racing happen.
          </p>
          <p>
            It is designed for racing fans, first time followers, families, social groups, punters and anyone who
            wants a deeper connection to the sport and the horse.
          </p>
          <p className="sign">Follow the journey. Feel part of the action.</p>
        </div>
        <div className="duo-media">
          <img
            src="/marketing/d9ffd002.jpg"
            alt="A trainer watches his horses work on the training track at sunrise"
            width={1040}
            height={780}
          />
        </div>
      </div>
    </section>
  );
}
