import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  measureMarquee,
  selectMode,
  shouldClone,
  wrapOffset,
  type CloneDecision,
} from "@/app/(marketing)/use-marquee";

/**
 * The marquee driver's decisions (ENG-589 / W3).
 *
 * These are unit tests on purpose. jsdom has no layout engine — every
 * `offsetWidth` is 0 — so a rendered test could never exercise the clone guard
 * at its boundary, which is the one comparison in this feature that has a real
 * bug behind it. The decisions are pure functions precisely so they can be
 * tested with the widths written down.
 */

const REPO = process.cwd();
const ROUTE_GROUP = path.join(REPO, "app", "(marketing)");

describe("marquee — input mode", () => {
  it("puts a touch device on native scroll even when it also asks for reduced motion", () => {
    // Order matters: the source returns the touch driver BEFORE it consults
    // reduced-motion, because on touch there is no rAF loop to reduce. Getting
    // this backwards would leave a phone with a static, unscrollable strip.
    expect(selectMode({ hoverNone: true, reducedMotion: true })).toBe("touch");
    expect(selectMode({ hoverNone: true, reducedMotion: false })).toBe("touch");
  });

  it("drops the drift but keeps the arrows for prefers-reduced-motion", () => {
    expect(selectMode({ hoverNone: false, reducedMotion: true })).toBe("reduced");
  });

  it("drifts on a hover-capable pointer", () => {
    expect(selectMode({ hoverNone: false, reducedMotion: false })).toBe("drift");
  });
});

describe("marquee — the clone guard (the 'same face twice' bug)", () => {
  // 19 cards of 222px with a 22px gap in an 1100px window: the real desktop case.
  const base: CloneDecision = {
    cardCount: 19,
    min: 4,
    setWidth: 19 * (222 + 22),
    stripWidth: 1100,
    leadWidth: 222 + 22,
  };

  it("clones when one set overhangs the window by more than a whole card", () => {
    expect(shouldClone(base)).toBe(true);
  });

  /**
   * THE BOUNDARY. At exactly `stripWidth + leadWidth` the lead clone sits flush
   * at the right edge — visible at the same moment as the original it copies.
   * That is the bug, so the boundary itself must fall on the static side, and
   * only one pixel past it may loop.
   */
  it("stays static AT the boundary and loops one pixel past it", () => {
    const boundary = base.stripWidth + base.leadWidth;

    expect(shouldClone({ ...base, setWidth: boundary })).toBe(false);
    expect(shouldClone({ ...base, setWidth: boundary - 1 })).toBe(false);
    expect(shouldClone({ ...base, setWidth: boundary + 1 })).toBe(true);
  });

  it("stays static when the strip is wider than a full set", () => {
    // Not a bug: every card is already on screen, so there is nothing to loop.
    expect(shouldClone({ ...base, stripWidth: 6000 })).toBe(false);
  });

  it("never loops at or below the minimum card count, however the widths fall", () => {
    // Four trainers on a phone would otherwise satisfy the width test and put
    // the same four faces on screen twice.
    expect(shouldClone({ ...base, cardCount: 4, setWidth: 99999 })).toBe(false);
    expect(shouldClone({ ...base, cardCount: 5, setWidth: 99999 })).toBe(true);
  });

  it("stays static with no cards at all", () => {
    expect(shouldClone({ ...base, cardCount: 0, setWidth: 0, leadWidth: 0 })).toBe(false);
  });
});

describe("marquee — offset wrapping", () => {
  const setWidth = 4636;

  it("wraps forward once the drift passes a full set", () => {
    expect(wrapOffset(setWidth + 12, setWidth)).toBe(12);
    expect(wrapOffset(setWidth, setWidth)).toBe(0);
  });

  /**
   * The regression this guards: nudging back from a standing start. Without the
   * negative branch the track translates the wrong way and drags the empty
   * space behind the strip into view.
   */
  it("wraps backward rather than going negative", () => {
    const cardStep = 244;
    const wrapped = wrapOffset(0 - cardStep, setWidth);

    expect(wrapped).toBe(setWidth - cardStep);
    expect(wrapped).toBeGreaterThan(0);
  });

  it("leaves an in-range offset alone", () => {
    expect(wrapOffset(0, setWidth)).toBe(0);
    expect(wrapOffset(setWidth - 1, setWidth)).toBe(setWidth - 1);
  });

  it("collapses to zero before anything has been measured", () => {
    // A nudge that lands before the first build must not produce NaN/-Infinity.
    expect(wrapOffset(-244, 0)).toBe(0);
  });
});

describe("marquee — measurement", () => {
  /**
   * `measureMarquee` sums the REAL cards rather than reading `scrollWidth`,
   * which is what lets a resize rebuild measure correctly while the previous
   * duplicate set is still rendered. Reading `scrollWidth` there would report
   * two sets and double the wrap length.
   */
  it("measures one set, ignoring duplicates already on screen", () => {
    const scroll = document.createElement("div");
    const track = document.createElement("div");
    scroll.appendChild(track);

    const addCard = (duplicate: boolean) => {
      const card = document.createElement("figure");
      if (duplicate) card.setAttribute("data-dup", "1");
      Object.defineProperty(card, "offsetWidth", { value: 222, configurable: true });
      track.appendChild(card);
    };

    for (let i = 0; i < 6; i += 1) addCard(false);
    for (let i = 0; i < 6; i += 1) addCard(true);
    Object.defineProperty(scroll, "clientWidth", { value: 900, configurable: true });

    const measurement = measureMarquee(scroll, track);

    expect(measurement.cardCount).toBe(6);
    // jsdom reports no column-gap, so the gap reads 0 and the sum is bare widths.
    expect(measurement.gap).toBe(0);
    expect(measurement.setWidth).toBe(6 * 222);
    expect(measurement.leadWidth).toBe(222);
    expect(measurement.stripWidth).toBe(900);
  });
});

/* ── guardrails ──────────────────────────────────────────────────────── */

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

const routeGroupSources = filesUnder(ROUTE_GROUP)
  .filter((file) => /\.tsx?$/.test(file))
  .map((file) => ({ file: path.relative(REPO, file), body: readFileSync(file, "utf8") }));

/**
 * The ONE file in this route group sanctioned to hold a form, a submit handler
 * and a `fetch` — ENG-726, the pre-launch waitlist capture.
 *
 * The two guardrails below were written for the v2.6 CONTACT path, whose whole
 * sin was a form that showed "Thanks, that is on its way." while sending
 * nothing. `waitlist-form.tsx` is the opposite of that: a real form that really
 * posts to our own route handler and reports what actually happened. Blanket-
 * banning `<form` across the route group would forbid it, so it is exempted BY
 * NAME rather than by loosening the pattern — a loosened regex would silently
 * re-admit a second fake contact form, which is the exact thing these tests
 * exist to prevent.
 *
 * The exemption is deliberately narrow. It does NOT cover `lib/supabase` (the
 * marketing origin still may not import Supabase — guardrail #1, and pinned
 * again in marketing-shell.test.tsx), and it does NOT cover `is-sent`, which
 * stays banned everywhere including here. Two tests below keep the sanction
 * honest: one proves the file really does still fetch and submit (so the
 * exemption is not dead weight left behind after a refactor), and one proves
 * every fetch in it targets our OWN same-origin route and never an outside
 * origin.
 */
const WAITLIST_FORM = path.join("app", "(marketing)", "waitlist-form.tsx");
const isWaitlistForm = (file: string) => file === WAITLIST_FORM;
const waitlistFormSource = () =>
  routeGroupSources.find(({ file }) => isWaitlistForm(file))?.body ?? "";

describe("marketing guardrails — the contact path really is a mailto", () => {
  /**
   * Guardrail #1, and the no-fictional-integrations rule.
   *
   * The whole marketing group is static and must reach nothing: no Supabase, no
   * fetch to any origin. The contact path in particular is a `mailto:` handed
   * to the visitor's own mail client, so there is no request to make.
   */
  it("makes no network call and imports no Supabase client anywhere under app/(marketing)/", () => {
    const offenders = routeGroupSources.filter(
      ({ file, body }) =>
        // Supabase is banned in EVERY file here, waitlist form included. Only
        // the network-call half of this guard is sanctioned, and only for that
        // one file.
        /lib\/supabase|@supabase\//.test(body) ||
        (/\bfetch\s*\(/.test(body) && !isWaitlistForm(file)),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  it("still finds a fetch and a form in the waitlist form, so the sanction is not dead", () => {
    // If ENG-726's component is ever refactored into something that no longer
    // fetches or submits, this fails and the exemption above should be deleted
    // rather than left as a standing hole in the guardrail.
    const body = waitlistFormSource();
    expect(body, "waitlist-form.tsx is missing from the route group").not.toBe("");
    expect(/\bfetch\s*\(/.test(body)).toBe(true);
    expect(/<form\b/.test(body)).toBe(true);
    expect(/onSubmit/.test(body)).toBe(true);
  });

  it("lets the waitlist form reach only our own same-origin route", () => {
    // The sanction buys it a fetch, not an arbitrary destination. Every
    // fetch(...) argument in the file must be the literal "/api/waitlist" — a
    // leading slash, so same-origin by construction, and never an absolute URL
    // to some third party. This is the no-fictional-integrations rule surviving
    // the exemption.
    const body = waitlistFormSource();
    const targets = [...body.matchAll(/\bfetch\s*\(\s*("[^"]*"|'[^']*'|`[^`]*`)/g)].map((m) =>
      m[1].slice(1, -1),
    );
    expect(targets.length, "no fetch target found to check").toBeGreaterThan(0);
    for (const target of targets) {
      expect(target, `fetch target ${target} is not our own route`).toBe("/api/waitlist");
    }
    // And no absolute origin anywhere in the file, however it is spelled.
    expect(/https?:\/\//.test(body), "waitlist-form.tsx names an absolute origin").toBe(false);
  });

  /**
   * v2.6 shows "Thanks, that is on its way." after a submit that never sent
   * anything. Removing it is the point of decision 6, so assert it is gone from
   * the SOURCE...
   */
  const CONFIRMATION_COPY = [
    "Thanks, that is on its way",
    "Someone from the stablepass. team will be in touch shortly",
    // Not just the full sentences: the fragments too, so a partial paraphrase
    // ("your message is on its way") cannot slip the check. This is strict
    // enough to catch a COMMENT that merely quotes the wording, which is
    // deliberate — the grep cannot tell prose from markup, and neither can a
    // reviewer skimming the built output.
    "on its way",
    "in touch shortly",
  ];

  /**
   * Whitespace is collapsed before searching, exactly as the betting guardrail
   * in `marketing-shell.test.tsx` does.
   *
   * Without it the check is trivially evaded by a line break, and not
   * hypothetically: the first version of this slice quoted the confirmation in
   * a `footer.tsx` doc comment, wrapped across two lines by the formatter, and
   * a contiguous search walked straight past it into the built output.
   */
  const flatten = (s: string) =>
    s
      // A sourcemap is JSON, so a source newline is the two characters `\` `n`,
      // not a real line break. Both forms have to normalise or the build sweep
      // has the same blind spot the source sweep had.
      .replace(/\\n/g, " ")
      // Comment gutters (` * `) sit between the words once a doc comment wraps.
      .replace(/[\s*]+/g, " ");

  it("renders no success confirmation for a message it never sent", () => {
    for (const phrase of CONFIRMATION_COPY) {
      const offenders = routeGroupSources.filter(({ body }) => flatten(body).includes(phrase));
      expect(offenders.map((o) => o.file), `"${phrase}" is still in the source`).toEqual([]);
    }
  });

  it("keeps no form, no submit handler and no is-sent toggle in the contact path", () => {
    const offenders = routeGroupSources.filter(
      ({ file, body }) =>
        // `is-sent` is the v2.6 fake-confirmation toggle and stays banned
        // outright, in every file including the sanctioned one. Only the
        // form/submit half is exempted, and only for ENG-726's component.
        /is-sent/.test(body) || (/onSubmit|<form\b/.test(body) && !isWaitlistForm(file)),
    );
    expect(offenders.map((o) => o.file)).toEqual([]);
  });

  /**
   * ...and the same claim checked against the artifact rather than a proxy for
   * it. A grep over `app/(marketing)/` cannot see copy that arrived from
   * anywhere else, and this criterion is written against the BUILT output.
   *
   * Note this deliberately does NOT grep for `is-sent`: `marketing.css` is W1's
   * file and still carries the (now dead) `.sent`/`.is-sent` rules, which are
   * flagged on the PR for W1 to drop rather than edited from here.
   *
   * `.map` is included in the sweep. Sourcemaps are part of the built output and
   * are servable, and they carry source COMMENTS — which is exactly how the
   * first version of this slice leaked the wording back in, in a comment
   * explaining that the wording had been removed.
   *
   * Skipped when there is no build to read — the repo's documented gate is
   * `typecheck && lint && build && test`, so it runs where it counts.
   */
  const BUILD_DIR = path.join(REPO, ".next");

  it.skipIf(!existsSync(BUILD_DIR))("ships no confirmation copy in the built output either", () => {
    const bundles = ["server", "static"]
      .map((sub) => path.join(BUILD_DIR, sub))
      .filter((dir) => existsSync(dir))
      .flatMap((dir) => filesUnder(dir))
      .filter((file) => /\.(js|html|json|rsc|txt|map)$/.test(file));

    expect(bundles.length).toBeGreaterThan(0);

    for (const phrase of CONFIRMATION_COPY) {
      // Flattened here too: a sourcemap embeds the comment's own line breaks.
      const hits = bundles.filter((file) => flatten(readFileSync(file, "utf8")).includes(phrase));
      expect(hits.map((f) => path.relative(REPO, f)), `"${phrase}" survived into the build`).toEqual([]);
    }
  });
});
