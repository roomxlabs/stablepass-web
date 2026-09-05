/**
 * Section 3 — `section#how.sec.band`, "How it works" (ENG-588 / W2).
 *
 * Nav target for "How it works" and the hero's "See how it works".
 *
 * The four steps are a CSS grid that the mockup's phone breakpoint turns into a
 * vertical timeline (the `.steps` rules and the saddle-cloth numbers do all of
 * it). No markup changes between the two layouts, so there is nothing responsive
 * to branch on here.
 */

const STEPS = [
  {
    n: "1",
    title: "Join stablepass.",
    body: "Get inside access to behind the scenes of some of the best trainers in Australia.",
  },
  {
    n: "2",
    title: "Follow participating stables",
    body: "We work with trainers who provide regular updates, photos, videos and more on selected horses.",
  },
  {
    n: "3",
    title: "Stay connected to the journey",
    body: "From training to race day, follow each horse's progress and enjoy the story behind the result.",
  },
  {
    n: "4",
    title: "Enjoy the racing experience",
    body: "Watch the journey unfold, follow upcoming races and feel more connected every time the horses step out.",
  },
];

export default function HowItWorks() {
  return (
    <section className="sec band" id="how">
      <div className="wrap">
        <div className="sec-head center rv" suppressHydrationWarning>
          <span className="eyebrow">How it works</span>
          <h2>Four steps. That&apos;s it.</h2>
        </div>
        <div className="steps rv" suppressHydrationWarning>
          {STEPS.map((step) => (
            <div className="step" key={step.n}>
              <span className="cloth">{step.n}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
