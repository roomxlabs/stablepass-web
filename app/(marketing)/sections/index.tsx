import CtaBand from "./cta";
import Faq from "./faq";
import ForTrainers from "./for-trainers";
import Hero from "./hero";
import HowItWorks from "./how-it-works";
import ImportantNote from "./important-note";
import Pricing from "./pricing";
import SubscribersGet from "./subscribers-get";
import TheApp from "./the-app";
import TrainersStrip from "./trainers-strip";
import type { Trainer } from "./trainers.data";
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
 * ENG-729: `joined`/`reason` are the marketing home's `searchParams`, threaded
 * to the two `WaitlistForm` mounts. Both are optional, so `<HomeSections />`
 * with no props still renders — which is how the copy-fidelity tests mount it.
 * See page.tsx for why they are read server-side at all.
 *
 * ENG-730: `trainers` is the LIVE roster, read from `public_trainer` in
 * `page.tsx` and passed straight through. It is a plain prop, and the read
 * deliberately does NOT happen here: the guardrail sweep in
 * `test/marketing-home.test.tsx` bans every backend-client import, and any
 * direct network call, from all files directly under `sections/`. This file
 * staying a pure composition is what keeps that guard honest rather than
 * exempted. Making it async would also break the copy-fidelity tests, which
 * render it synchronously.
 *
 * It defaults to EMPTY, which renders no strip at all. That is the deliberate
 * failure direction — `trainer.marketing_visible` defaults to false, so an empty
 * roster is the real launch state rather than an error.
 */
export default function HomeSections({
  joined,
  reason,
  trainers = [],
}: {
  joined?: string | null;
  reason?: string | null;
  trainers?: Trainer[];
} = {}) {
  return (
    <main>
      <Hero joined={joined} reason={reason} />
      <WhatIs />
      <HowItWorks />
      <TheApp />
      <SubscribersGet />
      <Pricing />
      <Why />
      <TrainersStrip trainers={trainers} />
      <CtaBand joined={joined} reason={reason} />
      <Faq />
      <ForTrainers />
      <ImportantNote />
    </main>
  );
}
