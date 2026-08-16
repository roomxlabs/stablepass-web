import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import HomeSections from "@/app/(marketing)/sections";
import { TRAINERS } from "@/app/(marketing)/sections/trainers.data";

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
  it("renders the twelve sections in the mockup's document order", () => {
    const { container } = render(<HomeSections />);
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
    const { container } = render(<HomeSections />);
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

describe("marketing home — trainers", () => {
  it("renders all nineteen cards from trainers.data.ts, in order", () => {
    const { container } = render(<HomeSections />);
    const cards = [...container.querySelectorAll(".tr-card")];

    expect(TRAINERS).toHaveLength(19);
    expect(cards).toHaveLength(19);
    expect(cards.map((c) => c.querySelector(".tr-nm")?.textContent)).toEqual(TRAINERS.map((t) => t.name));
  });

  it("gives each card the right name, location and photograph", () => {
    const { container } = render(<HomeSections />);
    const cards = [...container.querySelectorAll(".tr-card")];

    cards.forEach((card, i) => {
      const trainer = TRAINERS[i];
      expect(card.querySelector(".tr-nm")?.textContent).toBe(trainer.name);
      expect(card.getAttribute("data-loc")).toBe(trainer.location);
      expect(card.querySelector(".tr-over .loc")?.textContent).toBe(trainer.location);

      const img = card.querySelector("img");
      expect(img?.getAttribute("src")).toBe(trainer.photo);
      expect(img?.getAttribute("alt")).toBe(`${trainer.name}, ${trainer.location}`);
    });
  });

  it("keeps the initials fallback disc behind every photograph", () => {
    const { container } = render(<HomeSections />);
    const initials = [...container.querySelectorAll(".tr-card .tr-init")].map((el) => el.textContent);

    expect(initials).toEqual(TRAINERS.map((t) => t.initials));
  });

  it("declares the trainer count on the section, for W3's marquee", () => {
    const { container } = render(<HomeSections />);
    expect(container.querySelector("#stable-trainers")?.getAttribute("data-trainer-count")).toBe("19");
  });

  it("is markup only — no marquee arrows and no modal, which are W3's", () => {
    const { container } = render(<HomeSections />);
    const strip = container.querySelector("#stable-trainers")!;

    expect(strip.querySelector(".tr-ctrl")).toBeNull();
    expect(container.querySelector("#tr-modal")).toBeNull();
    // ...and the row is the mockup's own static state, so all 19 are visible with JS off.
    expect(container.querySelector(".tr-scroll")?.className).toContain("is-static");
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
    for (const file of sectionFiles()) {
      for (const line of file.body.split("\n")) {
        if (!/className="[^"]*\brv\b[^"]*"/.test(line)) continue;
        expect(line, `${file.name}: .rv element without suppressHydrationWarning`).toContain(
          "suppressHydrationWarning",
        );
      }
    }
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

  it("exposes nothing but name, location and photograph per trainer (guardrail #2)", () => {
    for (const trainer of TRAINERS) {
      expect(Object.keys(trainer).sort()).toEqual(["initials", "location", "name", "photo"]);
    }
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

/**
 * Copy fidelity. The strongest guard in this file: it diffs the rendered text of
 * every block against the same block in the signed-off mockup, so a reworded
 * heading, a dropped paragraph or a "corrected" Australian spelling all fail.
 */
describe.skipIf(!MOCKUP)("marketing home — copy matches the signed-off mockup verbatim", () => {
  it("matches block for block", () => {
    const mock = mockupDocument();
    const { container } = render(<HomeSections />);

    const mockBlocks = blocksOf(mock, "body");
    const ours = blocksOf(container, "main");

    expect(ours).toHaveLength(mockBlocks.length);

    ours.forEach((block, i) => {
      const expected = mockBlocks[i];
      const label = `${expected.tagName.toLowerCase()}${expected.id ? "#" + expected.id : ""}.${expected.className}`;
      expect(textRuns(block), `copy drift in ${label}`).toEqual(textRuns(expected));
    });
  });

  it("keeps the same section ids and classes", () => {
    const mock = mockupDocument();
    const { container } = render(<HomeSections />);

    const signature = (el: HTMLElement) => `${el.tagName.toLowerCase()}#${el.id}.${norm(el.className)}`;
    expect(blocksOf(container, "main").map(signature)).toEqual(blocksOf(mock, "body").map(signature));
  });

  it("points at the same extracted asset in the same place", () => {
    const mock = mockupDocument();
    const { container } = render(<HomeSections />);

    const sources = (root: ParentNode, scope: string) =>
      blocksOf(root, scope).flatMap((b) => [...b.querySelectorAll("img")].map((i) => i.getAttribute("src")));

    expect(sources(container, "main")).toEqual(sources(mock, "body"));
  });
});
