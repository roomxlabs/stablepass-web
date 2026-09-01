import CtaBand from "./cta";
import Faq from "./faq";
import ForTrainers from "./for-trainers";
import Hero from "./hero";
import HowItWorks from "./how-it-works";
import ImportantNote from "./important-note";
import Pricing from "./pricing";
import SubscribersGet from "./subscribers-get";
import TheApp from "./the-app";
import { type Trainer } from "./trainers.data";
import TrainersStrip from "./trainers-strip";
import WhatIs from "./what-is";
import Why from "./why";

/**
 * The marketing home, composed (ENG-588 / W2).
 *
 * Twelve sections in the signed-off mockup's document order, between the nav and
 * the footer the layout supplies. This file is the whole composition and nothing
 * else: every section owns its own file so W3, W4 and W5 can land beside it
 * without sharing one.
 *
 * `<main>` wraps them because the mockup put these straight in `<body>` and the
 * page needs a main landmark somewhere. It is a pure landmark — marketing.css has
 * no `main` selector, so it changes no layout. `id="top"` moved off W1's stub onto
 * the hero, where the mockup has it.
 *
 * Every string here and below is client-signed-off and FROZEN. Copy is verbatim,
 * trailing dot in "stablepass." included, Australian spellings included. If
 * something reads wrong, raise it — do not fix it in passing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY EVERY `.rv` ELEMENT CARRIES `suppressHydrationWarning`
 *
 * W1's layout ends the marketing wrapper with an inline, parser-blocking script
 * that adds `.in` to every `.rv` element. It runs during parse — before React
 * hydrates — so by hydration time the DOM says `class="tp-head rv in"` while the
 * server HTML React is reconciling against says `class="tp-head rv"`. That is a
 * hydration mismatch on all twenty-two reveal elements.
 *
 * It did not show up in W1 because W1 shipped the stylesheet and the script with
 * no `.rv` markup for them to act on. This ticket adds the markup, so the latent
 * mismatch becomes real, and it is loudest under `prefers-reduced-motion`, where
 * the script reveals everything up front instead of waiting on the observer.
 *
 * W1 already applied exactly this fix one level up — `suppressHydrationWarning`
 * on the `.marketing` wrapper, for the identical reason — but the prop does not
 * cascade to descendants, so each reveal element needs its own. It is a React
 * hint only and emits no attribute, so the served markup is unchanged.
 *
 * The alternative (moving the reveal script) lives in layout.tsx, which is W1's
 * file and ENG-591's live surface. This fix stays inside this ticket's own files.
 */
/**
 * `trainers` is threaded from the server page (`page.tsx`), which reads the
 * admin-driven list and falls back to the static one. Omitted — as in the
 * composition tests and any sync render — the strip uses its own static default,
 * so this component stays synchronous and the data fetch lives at the page edge.
 */
export type HomeSectionsProps = {
  trainers?: Trainer[];
};

export default function HomeSections({ trainers }: HomeSectionsProps = {}) {
  return (
    <main>
      <Hero />
      <WhatIs />
      <HowItWorks />
      <TheApp />
      <SubscribersGet />
      <Pricing />
      <Why />
      <TrainersStrip trainers={trainers} />
      <CtaBand />
      <Faq />
      <ForTrainers />
      <ImportantNote />
    </main>
  );
}
