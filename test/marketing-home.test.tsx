import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import TrainerModal from "@/app/(marketing)/modals/trainer-modal";
import HomeSections from "@/app/(marketing)/sections";
import { RETIRED_PLACEHOLDER_STRINGS, TRAINER_FIXTURE } from "@/test/fixtures/trainers";

const REPO = process.cwd();
const SECTION_DIR = path.join(REPO, "app", "(marketing)", "sections");
const ASSET_DIR = path.join(REPO, "public", "marketing");

/**
 * The exact "Important note" disclaimer, retyped here rather than imported.
 *
 * That is the point: importing the component's own string would assert nothing.
 * This literal is a second, independent copy of the signed-off wording, so any
 * paraphrase of guardrail #8's load-bearing sentence fails the suite instead of
 * shipping. If this ever needs to change, it changes because the client changed
 * it — not because the copy read awkwardly.
 */
const IMPORTANT_NOTE =
  "stablepass. is an entertainment and experience subscription. stablepass. does not sell shares in racehorses, syndicates, financial products, betting products, prize money rights, or investment returns. Subscribers receive content access and racing experiences only.";

/**
 * Every in-page anchor the W1 nav and footer emit. All of them are targets this
 * ticket has to supply — `#stable-trainers` is the footer's "Participating
 * stables" link and is easy to forget, since the nav does not use it.
 */
const NAV_ANCHORS = ["top", "how", "app", "members", "subscription", "stable-trainers", "trainers", "faq"];

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function sectionFiles() {
  return readdirSync(SECTION_DIR).map((name) => ({
    name,
    body: readFileSync(path.join(SECTION_DIR, name), "utf8"),
  }));
}

/**
 * Every file that renders a `.rv` reveal element.
 *
 * ENG-589 / W3 moved the trainer strip's `.rv` element out of `sections/` and
 * into `trainer-carousel.tsx`, which owns `.tr-scroll` now — the component that
 * measures the cards has to be the one that renders them. It is still a reveal
 * element and still has to opt out of the hydration check, so scanning only
 * `sections/` would quietly stop counting it.
 */
function revealFiles() {
  const carousel = path.join(REPO, "app", "(marketing)", "trainer-carousel.tsx");
  return [
    ...sectionFiles(),
    { name: "trainer-carousel.tsx", body: readFileSync(carousel, "utf8") },
  ];
}

/**
 * The mockup lives in a sibling design tree outside this repo, and its depth above
 * the repo root differs between a normal checkout and the loop's worktree. Absent
 * (CI, a fresh clone) → the mockup-derived tests skip rather than fail, exactly as
 * ENG-587's suite does.
 */
const MOCKUP_SUFFIX = "10-marketing-site/deploy/src/mockup.html";
function findMockup(): string | null {
  let dir = REPO;
  for (;;) {
    const candidate = path.join(dir, MOCKUP_SUFFIX);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
const MOCKUP = findMockup();

/**
 * The mockup inlines every image as a base64 data URI. W1 extracted each one to
 * `public/marketing/<first 8 of md5>.<ext>`, so replaying that same hash turns the
 * 4.7 MB source into a document whose `src` values are directly comparable with
 * what this page renders — which is how the asset test below proves we point at
 * the right photograph in the right slot, not merely at some file that exists.
 */
const MIME_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

function mockupDocument(): Document {
  const html = readFileSync(MOCKUP!, "utf8").replace(
    /data:(image\/[a-z.+-]+);base64,([A-Za-z0-9+/=\s]+)/g,
    (_match, mime: string, b64: string) => {
      const bytes = Buffer.from(b64.replace(/\s+/g, ""), "base64");
      const hash = createHash("md5").update(bytes).digest("hex").slice(0, 8);
      return `/marketing/${hash}.${MIME_EXT[mime] ?? "bin"}`;
    },
  );
  return new DOMParser().parseFromString(html, "text/html");
}

/**
 * Every non-empty text run under `root`, in document order.
 *
 * Comparing `textContent` directly does not work across the two trees: the mockup
 * is hand-indented HTML, so the parser keeps the newline between `</h1>` and the
 * next `<p>`, while React emits adjacent elements with nothing between them. That
 * difference is formatting, not copy. Diffing the text runs is insensitive to it
 * and still catches every reword, drop, insertion and reorder.
 */
function textRuns(root: Node): string[] {
  const walker = root.ownerDocument!.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const out: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = norm(node.nodeValue);
    if (text) out.push(text);
  }
  return out;
}

/** The twelve sections plus the hero's ribbon, in document order, from either tree. */
const BLOCK_SELECTOR = "header.hero, .ribbon, section";
function blocksOf(root: ParentNode, scope: string) {
  return [...root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)].filter(
    (el) => el.parentElement?.matches(scope) ?? false,
  );
}

describe("marketing home — composition", () => {
  // ENG-730: these assert the page's SHAPE, and the shape is only complete with
  // a published roster — an empty one legitimately drops the trainer section
  // (asserted separately under "marketing home — trainers"). So they render a
  // fixture roster; what they pin is the thirteen blocks and their order, never
  // which trainers are in them.
  it("renders the twelve sections in the mockup's document order", () => {
    const { container } = render(<HomeSections trainers={TRAINER_FIXTURE} />);
    const blocks = blocksOf(container, "main");

    // 12 sections + the hero's keyword ribbon, which is a sibling of the header.
    expect(blocks).toHaveLength(13);
    expect(blocks.map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${el.className}`)).toEqual([
      "header#top.hero",
      "div.ribbon",
      "section.sec",
      "section#how.sec band",
      "section#app.sec",
      "section#members.sec",
      "section#subscription.sec price-sec",
      "section.sec why",
      "section#stable-trainers.sec tr-sec",
      "section.",
      "section#faq.sec",
      "section#trainers.sec train-band train",
      "section.wrap note-band",
    ]);
  });

  it("gives every nav and footer anchor a real target", () => {
    const { container } = render(<HomeSections trainers={TRAINER_FIXTURE} />);
    for (const id of NAV_ANCHORS) {
      expect(container.querySelector(`#${id}`), `#${id} has no target`).not.toBeNull();
    }
  });

  it("puts the twelve sections inside a main landmark", () => {
    const { container } = render(<HomeSections />);
    expect(container.querySelector("main")).not.toBeNull();
  });
});

describe("marketing home — the frozen disclaimer (guardrail #8)", () => {
  it("reproduces the Important note character for character", () => {
    const { container } = render(<HomeSections />);
    const note = container.querySelector(".note-band .foot-note p");

    expect(note?.textContent).toBe(IMPORTANT_NOTE);
  });

  it("keeps every prohibition the wording carries", () => {
    const { container } = render(<HomeSections />);
    const note = container.querySelector(".note-band .foot-note p")?.textContent ?? "";

    for (const prohibited of [
      "does not sell shares in racehorses",
      "syndicates",
      "financial products",
      "betting products",
      "prize money rights",
      "investment returns",
    ]) {
      expect(note).toContain(prohibited);
    }
  });
});

/**
 * ENG-730 — THE TRAINER CARVE-OUT, STATED PLAINLY.
 *
 * These assertions used to pin the roster itself: nineteen cards, in
 * `trainers.data.ts` order, each with its hardcoded name, location and
 * photograph. That was correct while the data lived in the repo. The roster now
 * comes from the `public_trainer` view, so what appears here is a property of
 * the DATABASE, and re-pinning it would only pin a fixture to itself.
 *
 * What changed is the SOURCE of the roster, not the CONTRACT for rendering one.
 * So the contract is still asserted, exactly as hard, against a roster this test
 * supplies: the count, the order, the per-card fields, the initials disc, the
 * marquee wiring, the empty state. What is deliberately NO LONGER asserted is
 * WHICH trainers exist and HOW MANY — `test/marketing-trainers.test.tsx` covers
 * the read that produces them, and the e2e specs went count-agnostic in step.
 */
describe("marketing home — trainers", () => {
  const renderHome = () => render(<HomeSections trainers={TRAINER_FIXTURE} />);

  it("renders one card per trainer it is given, in order", () => {
    const { container } = renderHome();
    const cards = [...container.querySelectorAll(".tr-card")];

    expect(cards).toHaveLength(TRAINER_FIXTURE.length);
    expect(cards.map((c) => c.querySelector(".tr-nm")?.textContent)).toEqual(TRAINER_FIXTURE.map((t) => t.name));
  });

  it("gives each card the right name, location and photograph", () => {
    const { container } = renderHome();
    const cards = [...container.querySelectorAll(".tr-card")];

    cards.forEach((card, i) => {
      const trainer = TRAINER_FIXTURE[i]!;
      expect(card.querySelector(".tr-nm")?.textContent).toBe(trainer.name);
      expect(card.getAttribute("data-loc")).toBe(trainer.location);

      const img = card.querySelector("img");
      if (trainer.photo) {
        expect(img?.getAttribute("src")).toBe(trainer.photo);
        expect(img?.getAttribute("alt")).toBe(`${trainer.name}, ${trainer.location}`);
      } else {
        // The launch-common case: `marketing_photo_path` is null until an admin
        // copies a photo across, so there is no <img> at all and the initials
        // disc sitting behind it is simply what shows.
        expect(img).toBeNull();
      }

      // A live row may carry none of these, and an empty element still draws its
      // own spacing, so each is omitted rather than rendered blank.
      expect(card.querySelector(".tr-over .loc")?.textContent ?? "").toBe(trainer.location);
      expect(card.querySelector(".tr-over .hz")?.textContent ?? "").toBe(trainer.horses);
      expect(card.querySelector(".tr-over .bio")?.textContent ?? "").toBe(trainer.bio);
    });
  });

  it("keeps the initials fallback disc behind every card", () => {
    const { container } = renderHome();
    const initials = [...container.querySelectorAll(".tr-card .tr-init")].map((el) => el.textContent);

    expect(initials).toEqual(TRAINER_FIXTURE.map((t) => t.initials));
  });

  it("declares the REAL count on the section, whatever it is", () => {
    const { container } = renderHome();
    expect(container.querySelector("#stable-trainers")?.getAttribute("data-trainer-count")).toBe(
      String(TRAINER_FIXTURE.length),
    );
  });

  it("drops the whole section when nothing is published", () => {
    // Not hypothetical: `trainer.marketing_visible` defaults to false, so this
    // is the page every visitor gets until an admin opts stables in (W8).
    const { container } = render(<HomeSections />);

    expect(container.querySelector("#stable-trainers")).toBeNull();
    expect(container.querySelector("#tr-modal")).toBeNull();
  });

  it("renders none of the retired placeholder copy", () => {
    const { container } = renderHome();
    for (const retired of RETIRED_PLACEHOLDER_STRINGS) {
      expect(container.textContent).not.toContain(retired);
    }
  });

  /**
   * Was "is markup only — no marquee arrows and no modal, which are W3's". W3
   * (ENG-589) has landed, so the arrows and the modal are now expected here.
   *
   * `.is-static` is still asserted, and it is the important half: it is what the
   * SERVER renders, and jsdom has no layout, so the marquee measures zero-width
   * cards, declines to clone and leaves the static row exactly as a visitor with
   * scripting off would receive it. Every published card visible is the client's
   * review condition.
   */
  it("adds W3's arrows and modal without disturbing the no-JS static row", () => {
    const { container } = renderHome();
    const strip = container.querySelector("#stable-trainers")!;

    expect(strip.querySelectorAll(".tr-ctrl [data-tr]")).toHaveLength(2);
    expect(container.querySelector("#tr-modal")).not.toBeNull();
    expect(container.querySelector("#tr-modal")).not.toHaveAttribute("open");

    expect(container.querySelector(".tr-scroll")?.className).toContain("is-static");
    expect(container.querySelectorAll("[data-dup]")).toHaveLength(0);
  });
});

describe("marketing home — works with scripting off", () => {
  it("builds the FAQ from native details/summary", () => {
    const { container } = render(<HomeSections />);
    const items = [...container.querySelectorAll("#faq .faq > details")];

    expect(items).toHaveLength(7);
    for (const item of items) {
      expect(item.querySelector("summary")).not.toBeNull();
      expect(item.querySelector("p.a")).not.toBeNull();
    }
  });

  it("ships no onClick anywhere in the sections", () => {
    for (const file of sectionFiles()) {
      expect(file.body, `${file.name} adds behaviour`).not.toMatch(/onClick|useState|useEffect/);
    }
  });

  /**
   * W1's reveal script mutates `.rv` classes before React hydrates, so every one
   * of them has to opt out of the hydration check or the page logs a mismatch on
   * all twenty-two. See the note in sections/index.tsx.
   */
  it("opts every reveal element out of the hydration check", () => {
    // Matched per JSX opening TAG rather than per line, so a Prettier reflow that
    // pushes className onto its own line cannot turn this into a false failure.
    // `[^<>]` keeps a match inside one tag. The real DOM-level proof that this
    // works is the "hydrates cleanly" test in e2e/marketing-home.spec.ts; this one
    // is the cheap guard that catches a new section forgetting the prop.
    let checked = 0;
    for (const file of revealFiles()) {
      // No `s` flag needed (and it would raise the tsconfig target): `[^<>]`
      // already spans newlines, which is what makes this reflow-proof.
      for (const [tag] of file.body.matchAll(/<[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]*?)?\/?>/g)) {
        // Either a plain string className or an expression one — the carousel
        // toggles `.is-static` from state, so its className is a template
        // literal and the string-only form would silently skip it.
        if (!/className=(?:"[^"]*\brv\b|\{[^<>]*\brv\b)/.test(tag)) continue;
        checked += 1;
        expect(tag, `${file.name}: .rv element without suppressHydrationWarning`).toContain(
          "suppressHydrationWarning",
        );
      }
    }
    // ...and the scan actually found them, rather than the regex silently matching
    // nothing and the loop passing vacuously.
    expect(checked).toBe(22);
  });

  it("marks no section file as a client component", () => {
    for (const file of sectionFiles()) {
      expect(file.body, `${file.name} is a client component`).not.toMatch(/^\s*["']use client["']/m);
    }
  });
});

describe("marketing home — guardrails", () => {
  it("imports no backend client anywhere under sections/ (guardrail #1)", () => {
    for (const file of sectionFiles()) {
      expect(file.body, `${file.name} imports Supabase`).not.toMatch(/lib\/supabase/);
      expect(file.body, `${file.name} fetches`).not.toMatch(/\bfetch\s*\(/);
    }
  });

  it("exposes nothing but the marketing-safe fields per trainer (guardrail #2)", () => {
    // ENG-730 widened `Trainer` with `bio` + `horses`, which come from the
    // marketing-safe view ONLY, and `id`, which is a React key and is never
    // rendered. The list is still CLOSED: a field added here is a field
    // published on an anonymous page, so it has to fail this first.
    for (const trainer of TRAINER_FIXTURE) {
      expect(Object.keys(trainer).sort()).toEqual(["bio", "horses", "id", "initials", "location", "name", "photo"]);
    }
  });

  it("never renders the trainer id, which exists only as a React key", () => {
    const { container } = render(<HomeSections trainers={TRAINER_FIXTURE} />);
    for (const trainer of TRAINER_FIXTURE) {
      expect(container.innerHTML).not.toContain(trainer.id);
    }
  });

  it("never renders the trainer id in the OPEN modal either", () => {
    // The sweep above renders the modal CLOSED, so its body is not in the HTML
    // it inspects — and the modal is the component where a future edit would
    // most plausibly reach for an id (a profile link, an analytics hook). Open
    // it, so the one place the guard was blind to is covered.
    const { container } = render(<TrainerModal trainer={TRAINER_FIXTURE[0]!} onClose={() => {}} />);

    expect(container.querySelector("#trm-name")).not.toBeNull();
    expect(container.innerHTML).not.toContain(TRAINER_FIXTURE[0]!.id);
  });

  it("names no bookmaker, odds or betting product in the rendered copy (guardrail #8)", () => {
    const { container } = render(<HomeSections />);
    const copy = norm(container.textContent).toLowerCase();

    // The only two places the word "betting" may appear are prohibitions: the
    // Important note and the FAQ answer about shares and prize money. Everything
    // else must be clean, and these terms may not appear at all.
    const outsideNote = copy.replace(norm(IMPORTANT_NOTE).toLowerCase(), "");
    for (const banned of ["bookmaker", "odds", "wager", "bet now", "place a bet", "$4.60", "starting price"]) {
      expect(outsideNote, `copy mentions ${banned}`).not.toContain(banned);
    }
  });

  it("uses the word betting only to disclaim it", () => {
    const { container } = render(<HomeSections />);

    for (const node of container.querySelectorAll("p, li, summary")) {
      const text = norm(node.textContent);
      if (!/betting/i.test(text)) continue;
      expect(text, `"${text}" mentions betting outside a prohibition`).toMatch(
        /does not sell|do not receive/i,
      );
    }
  });
});

describe("marketing home — assets", () => {
  it("references extracted files under public/marketing, never a data URI", () => {
    const { container } = render(<HomeSections />);
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");

    expect(sources.length).toBeGreaterThan(0);
    for (const src of sources) {
      expect(src).toMatch(/^\/marketing\/[0-9a-f]{8}\.(jpg|png)$/);
      expect(existsSync(path.join(ASSET_DIR, src.replace("/marketing/", "")))).toBe(true);
    }
  });

  it("uses the v2.7 post-race screen, not the withdrawn odds one", () => {
    const { container } = render(<HomeSections />);
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));

    expect(sources).toContain("/marketing/3334430f.jpg");
    expect(sources).not.toContain("/marketing/f70905af.jpg");
  });

  it("gives every content image alt text", () => {
    const { container } = render(<HomeSections />);
    for (const img of container.querySelectorAll("img")) {
      const decorative = img.getAttribute("aria-hidden") === "true";
      expect(decorative || (img.getAttribute("alt") ?? "").length > 0).toBe(true);
    }
  });
});

const signatureOf = (el: HTMLElement) => `${el.tagName.toLowerCase()}#${el.id}.${norm(el.className)}`;
const imagesOf = (el: HTMLElement) => [...el.querySelectorAll("img")].map((i) => i.getAttribute("src"));

/**
 * COPY FIDELITY — LAYER 1, always on, including CI.
 *
 * The signed-off mockup lives in a sibling design tree that is deliberately not in
 * this repo, so a check that reads it directly can only run on a machine that has
 * that tree — it skips on CI and on any fresh clone, and the copy freeze quietly
 * stops being enforced exactly where it matters most.
 *
 * So the mockup is distilled into a committed fixture by
 * scripts/extract-marketing-copy.mjs, and this layer diffs the rendered page
 * against that. Layer 2 below keeps the fixture honest.
 */
describe("marketing home — copy matches the frozen fixture", () => {
  const fixture = JSON.parse(
    readFileSync(path.join(REPO, "test", "fixtures", "marketing-copy.json"), "utf8"),
  ) as { blocks: { signature: string; runs: string[]; images: (string | null)[] }[] };

  /**
   * ENG-730 — THE TRAINER BLOCK LEAVES THE COPY FREEZE. Documented, bounded, and
   * subtracted rather than deleted.
   *
   * The fixture froze 136 text runs for `section#stable-trainers.sec tr-sec` —
   * nineteen names, nineteen locations, and nineteen copies of the placeholder
   * bio and horse line. Every one of those was repo data. They are now rows in
   * `public_trainer`, chosen by an admin, so there is no longer any string this
   * block is REQUIRED to render, and a frozen comparison against live content
   * cannot mean anything.
   *
   * So this ONE block is exempted from the run comparison. What replaces it:
   *
   *   - the exemption is exactly one block, pinned by signature below, and the
   *     other TWELVE stay frozen byte for byte, additions and all;
   *   - the block must still EXIST, in its fixture position — the exemption
   *     covers its text, never its presence or its order;
   *   - the anti-vacuity count is re-pinned to the remaining blocks, so the
   *     freeze cannot be hollowed out by exempting more later;
   *   - the block's own rendering contract did not go unasserted, it MOVED: see
   *     "marketing home — trainers" above and test/marketing-trainers.test.tsx.
   *
   * The strip is rendered from TRAINER_FIXTURE here, not from an empty roster,
   * because an empty roster drops the section entirely and the block-order
   * assertion below is worth keeping honest.
   */
  /**
   * The exemption is an ALLOW-LIST OF ONE, and it is a list rather than a
   * constant on purpose: both the subtraction below and the anti-vacuity count
   * read from it, so a second exemption cannot be added in one place and go
   * unnoticed in the other. Adding to this array fails the length assertion in
   * "covers the whole page" immediately. Same shape as the pinned allow-lists
   * ENG-600 and ENG-729 used for the CSS guard.
   */
  const EXEMPT_BLOCKS = ["section#stable-trainers.sec tr-sec"];
  const LIVE_DATA_BLOCK = EXEMPT_BLOCKS[0]!;
  const isExempt = (signature: string) => EXEMPT_BLOCKS.includes(signature);
  const renderFrozen = () => render(<HomeSections trainers={TRAINER_FIXTURE} />);

  it("renders the same blocks, in the same order", () => {
    const { container } = renderFrozen();
    expect(blocksOf(container, "main").map(signatureOf)).toEqual(fixture.blocks.map((b) => b.signature));
  });

  it("still carries the live block, in its frozen position", () => {
    // The subtraction below is about TEXT. The block itself must not quietly
    // vanish or move, which is the failure the exemption could otherwise hide.
    expect(fixture.blocks.map((b) => b.signature).filter((sig) => sig === LIVE_DATA_BLOCK)).toEqual([LIVE_DATA_BLOCK]);

    const { container } = renderFrozen();
    expect(blocksOf(container, "main").map(signatureOf).indexOf(LIVE_DATA_BLOCK)).toBe(
      fixture.blocks.findIndex((b) => b.signature === LIVE_DATA_BLOCK),
    );
  });

  /**
   * ENG-729 — the waitlist cutover's copy, layered OVER the frozen fixture.
   *
   * The fixture is distilled from the signed-off mockup, which predates the
   * waitlist entirely and therefore contains none of this copy. Regenerating it
   * was the obvious move and is the wrong one: the fixture's whole job is to be
   * the thing the page is checked against, so rebuilding it from the page makes
   * the check circular and freezes whatever drifted in alongside. Instead the
   * additions are pinned here, per block, and subtracted before the comparison.
   *
   * That keeps both halves of the guarantee, and this is the part worth reading:
   *
   *   - nothing may be REMOVED or REORDERED. After the subtraction the runs must
   *     equal the fixture exactly, so hiding a mockup line in waitlist mode
   *     would fail here even though CSS `display:none` leaves the DOM untouched
   *     — which is precisely why every hide in this ticket is CSS-only.
   *   - nothing may be ADDED except these strings. An unpinned run survives the
   *     subtraction and breaks the same equality.
   *   - the allow-list cannot go stale. Every pinned string must actually
   *     render, or `remaining` is non-empty and this fails — so when the mode
   *     flips back to "trial" on launch day, this test tells you to delete the
   *     list rather than leaving a permanent hole in the copy freeze.
   *
   * Keys are fixture block signatures. `section#.` is the CTA band, the one
   * section the mockup gives neither an id nor a class.
   */
  const WAITLIST_ADDITIONS: Record<string, string[]> = {
    "header#top.hero": [
      // The locked pre-launch line and fine print (ENG-721 decisions 5 and 6).
      "Join the waitlist to enable your 30-day free trial",
      "$19 a month after your free trial",
      // ENG-726's form: its field label and its submit button.
      "Email address",
      "Join the waitlist",
    ],
    "section#.": ["Email address", "Join the waitlist"],
  };

  it("renders every string verbatim, plus only ENG-729's pinned waitlist copy", () => {
    const { container } = renderFrozen();
    blocksOf(container, "main").forEach((block, i) => {
      const { signature, runs: want } = fixture.blocks[i];

      // ENG-730's one documented subtraction — see EXEMPT_BLOCKS above.
      if (isExempt(signature)) return;

      // Subtracted one occurrence at a time, not with a set: "Join the waitlist"
      // is both the button label and part of the line above it in the hero, and
      // a set-based filter would strip every copy of a string the mockup might
      // legitimately repeat.
      const remaining = [...(WAITLIST_ADDITIONS[signature] ?? [])];
      const withoutAdditions = textRuns(block).filter((run) => {
        const at = remaining.indexOf(run);
        if (at === -1) return true;
        remaining.splice(at, 1);
        return false;
      });

      expect(remaining, `pinned waitlist copy never rendered in ${signature}`).toEqual([]);
      expect(withoutAdditions, `copy drift in ${signature}`).toEqual(want);
    });
  });

  it("confines the waitlist copy to the two conversion blocks", () => {
    // The cutover adds a capture form in the hero and in the CTA band, and
    // nowhere else. If a third block ever needs an entry, that is a scope
    // change to argue on the ticket, not a line to add here quietly.
    expect(Object.keys(WAITLIST_ADDITIONS).sort()).toEqual(["header#top.hero", "section#."]);
    expect(fixture.blocks.map((b) => b.signature)).toEqual(expect.arrayContaining(Object.keys(WAITLIST_ADDITIONS)));
  });

  it("points at the same extracted asset in the same place", () => {
    const { container } = renderFrozen();
    blocksOf(container, "main").forEach((block, i) => {
      // Same subtraction, same reason: the trainer photographs are no longer
      // extracted assets under /marketing/ but public-bucket URLs chosen by an
      // admin. `test/marketing-shell.test.tsx` still pins the extracted asset
      // set, and this ticket deleted the nineteen that went orphaned with them.
      if (isExempt(fixture.blocks[i].signature)) return;
      expect(imagesOf(block), `asset drift in ${fixture.blocks[i].signature}`).toEqual(fixture.blocks[i].images);
    });
  });

  it("covers the whole page, so none of the above can pass vacuously", () => {
    expect(fixture.blocks).toHaveLength(13);

    // ENG-730 re-pins this to the blocks that are STILL FROZEN. The page-wide
    // total was >250; the trainer block alone carried 136 of those runs, so
    // leaving the old threshold in place would have made this pass on the
    // remaining twelve by luck rather than by coverage. Exactly one block is
    // exempt, and this is what makes exempting a second one fail here.
    // EXACTLY one block may be exempt. This is the assertion that stops the
    // copy freeze being hollowed out one block at a time.
    expect(EXEMPT_BLOCKS, "a second block was exempted from the copy freeze").toHaveLength(1);

    const frozen = fixture.blocks.filter((b) => !isExempt(b.signature));
    expect(frozen).toHaveLength(12);
    expect(frozen.reduce((n, b) => n + b.runs.length, 0)).toBeGreaterThan(170);
  });
});

/**
 * COPY FIDELITY — LAYER 2, only where the design tree is reachable.
 *
 * Proves the committed fixture is still a faithful distillation of the mockup. On
 * its own layer 1 would happily freeze a typo forever; this is what stops that.
 * It skips cleanly when the mockup is absent — and note the reads sit inside the
 * `it` bodies, not the describe callback, which is the ENG-596 trap.
 */
describe.skipIf(!MOCKUP)("marketing home — the frozen fixture still matches the mockup", () => {
  it("matches the mockup block for block", () => {
    const fixture = JSON.parse(
      readFileSync(path.join(REPO, "test", "fixtures", "marketing-copy.json"), "utf8"),
    ) as { blocks: { signature: string; runs: string[]; images: (string | null)[] }[] };

    // ENG-600: copy the mockup carries but the site deliberately does NOT ship.
    // Listed verbatim so the deviation is auditable and so anything else that
    // goes missing from the fixture still fails this test.
    const DELIBERATELY_DROPPED = [
      // Reviewer-facing note written for the client during design review. It sat
      // on the public page and disclosed the admin portal to subscribers.
      "Photographs and locations are the real supplied trainer details. Bios and horse counts are placeholders pending the stables, and are editable from the admin portal.",
    ];

    const live = blocksOf(mockupDocument(), "body").map((el) => ({
      signature: signatureOf(el),
      runs: textRuns(el).filter((run) => !DELIBERATELY_DROPPED.includes(run)),
      images: imagesOf(el),
    }));

    // If the mockup ever stops carrying one of these, the filter above has
    // quietly become a no-op and this list should shrink with it.
    const mockupRuns = blocksOf(mockupDocument(), "body").flatMap((el) => textRuns(el));
    for (const dropped of DELIBERATELY_DROPPED) {
      expect(mockupRuns).toContain(dropped);
    }

    expect(live).toEqual(fixture.blocks);
  });
});
